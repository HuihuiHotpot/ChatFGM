import {
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type {
  SettingsCapabilityGroup,
  SettingsChatGptAccount,
  SettingsCliRuntime,
  SettingsRuntimeState,
  SettingsSnapshot,
  SettingsToolboxRuntime,
  ToolboxOption,
} from '../../services/capabilities';
import './SettingsDialog.css';

type SettingsTab = 'cli' | 'models' | 'toolboxes';
type ProbeState = 'idle' | 'pending' | 'ok' | 'error';
type ScanState = 'idle' | 'loading' | 'ready' | 'error';

interface ServiceErrors {
  name?: string;
  baseUrl?: string;
  key?: string;
}

interface ServiceDraft {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  keyValue: string;
  isNew: boolean;
  errors: ServiceErrors;
  testState: ProbeState;
  testMessage: string;
  testToken: number;
}

interface ToolboxEnvDraft {
  path: string;
  state: ProbeState;
  message: string;
  token: number;
}

type CliProbeSource = 'idle' | 'runtime' | 'detection';

interface CliProbe {
  state: ProbeState;
  version: string;
  message: string;
  token: number;
  source: CliProbeSource;
  runtimeRevision: number;
  runtimeFingerprint: string;
}

export interface SettingsDialogProps {
  loading: boolean;
  loadError: string;
  snapshot: SettingsSnapshot | null;
  runtime: SettingsRuntimeState | null;
  capabilities: SettingsCapabilityGroup;
  returnFocusTarget?: HTMLElement | null;
  onRetryLoad: () => void;
  onClose: () => void;
  onSaved: (snapshot: SettingsSnapshot, notice: string) => void;
}

let serviceSequence = 0;

function nextServiceId(): string {
  serviceSequence += 1;
  const random =
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${serviceSequence}`;
  return `settings-service-${random}`;
}

function serviceIsValid(service: ServiceDraft): boolean {
  return (
    Boolean(service.name.trim()) &&
    /^https?:\/\//i.test(service.baseUrl.trim()) &&
    (service.hasKey || Boolean(service.keyValue.trim()))
  );
}

function validServiceFields(
  service: Pick<ServiceDraft, 'name' | 'baseUrl'>,
): ServiceErrors {
  const errors: ServiceErrors = {};
  if (!service.name.trim()) {
    errors.name = '请填写服务名称。';
  }
  if (!service.baseUrl.trim()) {
    errors.baseUrl = '请填写 API 地址。';
  } else if (!/^https?:\/\//i.test(service.baseUrl.trim())) {
    errors.baseUrl = 'API 地址需以 http:// 或 https:// 开头。';
  }
  return errors;
}

function statusBadgeTone(
  state: ProbeState | undefined,
): string {
  if (state === 'ok') return 'settings-badge is-ok';
  if (state === 'error' || state === 'pending') {
    return 'settings-badge is-warn';
  }
  return 'settings-badge';
}

function initialToolboxStatus(
  path: string,
  runtime: SettingsToolboxRuntime | undefined,
): Pick<ToolboxEnvDraft, 'state' | 'message'> {
  if (
    path &&
    runtime &&
    runtime.path === path &&
    (runtime.state === 'ok' || runtime.state === 'error')
  ) {
    return {
      state: runtime.state,
      message: runtime.message ?? '',
    };
  }
  return { state: 'idle', message: '' };
}

function normalizeCliPath(path: string): string {
  return path
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function cliRuntimeMatchesPath(
  runtime: SettingsCliRuntime,
  draftPath: string,
  savedPath: string,
): boolean {
  const normalizedDraft = normalizeCliPath(draftPath);
  if (!normalizedDraft) return false;
  const runtimePath = runtime.path
    ? normalizeCliPath(runtime.path)
    : '';
  if (runtimePath) return runtimePath === normalizedDraft;
  const normalizedSaved = normalizeCliPath(savedPath);
  return Boolean(normalizedSaved) && normalizedSaved === normalizedDraft;
}

function cliRuntimeFingerprint(runtime: SettingsCliRuntime): string {
  return JSON.stringify([
    runtime.state,
    runtime.path ? normalizeCliPath(runtime.path) : '',
    runtime.version ?? '',
    runtime.message ?? '',
  ]);
}

function cliProbeFromRuntime(
  runtime: SettingsCliRuntime,
  runtimeRevision: number,
  token: number,
): CliProbe {
  return {
    state:
      runtime.state === 'connected'
        ? 'ok'
        : runtime.state === 'error'
          ? 'error'
          : runtime.state === 'connecting'
            ? 'pending'
            : 'idle',
    version: runtime.state === 'connected' ? runtime.version ?? '' : '',
    message: runtime.message ?? '',
    token,
    source: 'runtime',
    runtimeRevision,
    runtimeFingerprint: cliRuntimeFingerprint(runtime),
  };
}

function cliStateLabel(state: ProbeState): string {
  if (state === 'pending') return '检测中';
  if (state === 'ok') return '已连接';
  if (state === 'error') return '连接失败';
  return '未检测';
}

function toolboxBadgeLabel(
  draft: ToolboxEnvDraft | undefined,
): string {
  if (!draft?.path) return '未配置';
  if (draft.state === 'pending') return '检测中';
  if (draft.state === 'ok') return '可用';
  if (draft.state === 'error') return '检测失败';
  return '未检测';
}

function modelRuntimeLabel(
  state: 'inactive' | 'preparing' | 'ready' | 'error',
): string {
  if (state === 'preparing') return '准备中';
  if (state === 'ready') return '已就绪';
  if (state === 'error') return '激活失败';
  return '未启用';
}

export function SettingsDialog({
  loading,
  loadError,
  snapshot,
  runtime,
  capabilities,
  returnFocusTarget,
  onRetryLoad,
  onClose,
  onSaved,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('cli');
  const [cliPath, setCliPath] = useState('');
  const [cliProbe, setCliProbe] = useState<CliProbe>({
    state: 'idle',
    version: '',
    message: '',
    token: 0,
    source: 'idle',
    runtimeRevision: 0,
    runtimeFingerprint: '',
  });
  const [cliBrowseError, setCliBrowseError] = useState('');
  const [mode, setMode] = useState<'chatgpt' | 'api'>('chatgpt');
  const [services, setServices] = useState<ServiceDraft[]>([]);
  const [activeServiceId, setActiveServiceId] = useState<
    string | null
  >(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [authError, setAuthError] = useState('');
  const [toolboxes, setToolboxes] = useState<ToolboxOption[]>([]);
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanError, setScanError] = useState('');
  const [selectedToolboxId, setSelectedToolboxId] = useState<
    string | null
  >(null);
  const [envDrafts, setEnvDrafts] = useState<
    Record<string, ToolboxEnvDraft>
  >({});
  const [envPickErrors, setEnvPickErrors] = useState<
    Record<string, string>
  >({});
  const [cancelServiceId, setCancelServiceId] = useState<
    string | null
  >(null);
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const busyRef = useRef(new Set<string>());
  const servicesRef = useRef<ServiceDraft[]>([]);
  servicesRef.current = services;
  const mountedRef = useRef(false);
  const runRef = useRef(0);
  const initializedRef = useRef(false);
  const savingRef = useRef(false);
  const cliTokenRef = useRef(0);
  const scanTokenRef = useRef(0);
  const serviceTokenRef = useRef(0);
  const serviceTestTokensRef = useRef(new Map<string, number>());
  const serviceTestRequestsRef = useRef(new Map<string, number>());
  const envTokenRef = useRef(0);
  const envDetectTokensRef = useRef(new Map<string, number>());
  const envPickTokensRef = useRef(new Map<string, number>());
  const firstTabRef = useRef<HTMLButtonElement>(null);
  const serviceNameRef = useRef<HTMLInputElement>(null);
  const focusServiceNameRef = useRef(false);

  const effectiveRuntime = runtime ?? snapshot?.runtime ?? null;
  const account: SettingsChatGptAccount =
    effectiveRuntime?.chatgpt ?? {
      status: 'logged-out',
    };
  const cliPathRef = useRef(cliPath);
  cliPathRef.current = cliPath;
  const cliProbeRef = useRef(cliProbe);
  cliProbeRef.current = cliProbe;
  const effectiveRuntimeRef = useRef(effectiveRuntime);
  effectiveRuntimeRef.current = effectiveRuntime;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!snapshot || initializedRef.current) return;
    initializedRef.current = true;
    const saved = snapshot.saved;
    setCliPath(saved.cli.path);
    const runtimeCli = snapshot.runtime.cli;
    if (
      cliRuntimeMatchesPath(
        runtimeCli,
        saved.cli.path,
        saved.cli.path,
      )
    ) {
      setCliProbe(
        cliProbeFromRuntime(
          runtimeCli,
          snapshot.runtime.revision,
          0,
        ),
      );
    } else {
      setCliProbe({
        state: 'idle',
        version: '',
        message: '',
        token: 0,
        source: 'idle',
        runtimeRevision: 0,
        runtimeFingerprint: '',
      });
    }
    setMode(saved.models.mode);
    setServices(
      saved.models.services.map((service) => ({
        ...service,
        keyValue: '',
        isNew: false,
        errors: {},
        testState: 'idle',
        testMessage: '',
        testToken: 0,
      })),
    );
    setActiveServiceId(saved.models.activeServiceId);
    const envs: Record<string, ToolboxEnvDraft> = {};
    for (const environment of saved.toolboxes.environments) {
      const status = initialToolboxStatus(
        environment.environmentPath,
        snapshot.runtime.toolboxEnvironments[environment.toolboxId],
      );
      envs[environment.toolboxId] = {
        path: environment.environmentPath,
        ...status,
        token: 0,
      };
    }
    setEnvDrafts(envs);
    setSelectedToolboxId(
      saved.toolboxes.environments[0]?.toolboxId ?? null,
    );
    setScanState('idle');
    setScanError('');
  }, [snapshot]);

  useEffect(() => {
    if (!initializedRef.current || !snapshot || !effectiveRuntime) {
      return;
    }
    const draftPath = cliPathRef.current;
    if (
      !cliRuntimeMatchesPath(
        effectiveRuntime.cli,
        draftPath,
        snapshot.saved.cli.path,
      )
    ) {
      return;
    }
    const current = cliProbeRef.current;
    if (
      cliRuntimeFingerprint(effectiveRuntime.cli) ===
        current.runtimeFingerprint ||
      effectiveRuntime.revision <= current.runtimeRevision
    ) {
      return;
    }
    setCliProbe(
      cliProbeFromRuntime(
        effectiveRuntime.cli,
        effectiveRuntime.revision,
        ++cliTokenRef.current,
      ),
    );
  }, [effectiveRuntime, snapshot, cliPath]);

  useEffect(() => {
    if (focusServiceNameRef.current && activeServiceId) {
      focusServiceNameRef.current = false;
      window.setTimeout(() => serviceNameRef.current?.focus(), 0);
    }
  }, [activeServiceId, services.length]);

  const authPending =
    busy.has('auth') || account.status === 'authorizing';

  useEffect(() => {
    if (account.status === 'logged-in') setAuthError('');
  }, [account.status]);

  function markBusy(key: string, active: boolean) {
    if (active) busyRef.current.add(key);
    else busyRef.current.delete(key);
    if (mountedRef.current) setBusy(new Set(busyRef.current));
  }

  function isBusy(key: string): boolean {
    return busyRef.current.has(key);
  }

  function isMountedRun(run: number): boolean {
    return mountedRef.current && runRef.current === run;
  }

  function requestClose() {
    if (savingRef.current) return;
    runRef.current += 1;
    if (
      busyRef.current.has('auth') ||
      account.status === 'authorizing'
    ) {
      void capabilities
        .cancelChatGptLogin()
        .catch(() => undefined);
    }
    if (capabilities.cancelPendingOperations) {
      void capabilities
        .cancelPendingOperations()
        .catch(() => undefined);
    }
    onClose();
  }

  function updateService(
    serviceId: string,
    patch: Partial<ServiceDraft>,
    resetTest = true,
  ) {
    if (resetTest) {
      serviceTestTokensRef.current.set(
        serviceId,
        (serviceTestTokensRef.current.get(serviceId) ?? 0) + 1,
      );
    }
    setServices((current) =>
      current.map((service) =>
        service.id === serviceId
          ? {
              ...service,
              ...patch,
              testState:
                resetTest && patch.testState === undefined
                  ? 'idle'
                  : (patch.testState ?? service.testState),
              testMessage:
                resetTest && patch.testMessage === undefined
                  ? ''
                  : (patch.testMessage ?? service.testMessage),
              testToken: resetTest
                ? service.testToken + 1
                : service.testToken,
            }
          : service,
      ),
    );
  }

  function fieldErrorFor(
    service: ServiceDraft,
  ): ServiceErrors {
    return service.errors;
  }

  function validateServiceForSubmit(service: ServiceDraft): ServiceErrors {
    const errors = validServiceFields(service);
    if (!service.hasKey && !service.keyValue.trim()) {
      errors.key = '请填写 API Key。';
    }
    return errors;
  }

  function selectService(serviceId: string) {
    const service = services.find((item) => item.id === serviceId);
    if (!service) return;
    setActiveServiceId(serviceId);
    setKeyVisible(false);
    setServices((current) =>
      current.map((item) =>
        item.id === serviceId ? { ...item, errors: {} } : item,
      ),
    );
  }

  function removeService(serviceId: string) {
    const service = services.find((item) => item.id === serviceId);
    if (!service) return;
    if (
      service.isNew &&
      (service.name.trim() ||
        service.baseUrl.trim() ||
        service.keyValue.trim())
    ) {
      setCancelServiceId(serviceId);
      return;
    }
    performRemoveService(serviceId);
  }

  function performRemoveService(serviceId: string) {
    const index = services.findIndex((item) => item.id === serviceId);
    if (index < 0) return;
    const nextServices = services.filter(
      (item) => item.id !== serviceId,
    );
    serviceTestTokensRef.current.delete(serviceId);
    if (serviceTestRequestsRef.current.has(serviceId)) {
      serviceTestRequestsRef.current.delete(serviceId);
      markBusy(`service-test:${serviceId}`, false);
    }
    setServices(nextServices);
    if (activeServiceId === serviceId) {
      const nextActive =
        nextServices[Math.min(index, nextServices.length - 1)]?.id ??
        null;
      setActiveServiceId(nextActive);
      setKeyVisible(false);
    }
    setCancelServiceId(null);
  }

  function addService() {
    const id = nextServiceId();
    setServices((current) => [
      ...current,
      {
        id,
        name: '',
        baseUrl: '',
        hasKey: false,
        keyValue: '',
        isNew: true,
        errors: {},
        testState: 'idle',
        testMessage: '',
        testToken: 0,
      },
    ]);
    setActiveServiceId(id);
    setKeyVisible(false);
    focusServiceNameRef.current = true;
  }

  function requestCancelNewService() {
    if (!activeServiceId) return;
    const service = services.find(
      (item) => item.id === activeServiceId,
    );
    if (!service?.isNew) return;
    if (
      !service.name.trim() &&
      !service.baseUrl.trim() &&
      !service.keyValue.trim()
    ) {
      performRemoveService(service.id);
      return;
    }
    setCancelServiceId(service.id);
  }

  function currentServiceTest(
    service: ServiceDraft,
    token: number,
    run: number,
  ): ServiceDraft | null {
    if (!isMountedRun(run)) return null;
    if (serviceTestTokensRef.current.get(service.id) !== token) {
      return null;
    }
    const current = servicesRef.current.find(
      (item) => item.id === service.id,
    );
    if (
      !current ||
      current.name.trim() !== service.name.trim() ||
      current.baseUrl.trim() !== service.baseUrl.trim() ||
      current.keyValue !== service.keyValue
    ) {
      return null;
    }
    return current;
  }

  function finishServiceTest(serviceId: string, token: number) {
    if (serviceTestRequestsRef.current.get(serviceId) !== token) {
      return false;
    }
    serviceTestRequestsRef.current.delete(serviceId);
    markBusy(`service-test:${serviceId}`, false);
    return true;
  }

  function testService(service: ServiceDraft) {
    if (isBusy(`service-test:${service.id}`)) return;
    const errors = validateServiceForSubmit(service);
    if (Object.keys(errors).length > 0) {
      updateService(service.id, { errors }, false);
      return;
    }
    const run = runRef.current;
    const token = ++serviceTokenRef.current;
    serviceTestTokensRef.current.set(service.id, token);
    serviceTestRequestsRef.current.set(service.id, token);
    updateService(
      service.id,
      {
        errors: {},
        testState: 'pending',
        testMessage: '',
        testToken: token,
      },
      false,
    );
    markBusy(`service-test:${service.id}`, true);
    void capabilities
      .testServiceConnection({
        service: {
          id: service.id,
          name: service.name.trim(),
          baseUrl: service.baseUrl.trim(),
          ...(service.keyValue.trim()
            ? { key: service.keyValue }
            : {}),
        },
        keepSavedKey: service.hasKey && !service.keyValue.trim(),
      })
      .then((result) => {
        finishServiceTest(service.id, token);
        if (!currentServiceTest(service, token, run)) return;
        if (result.status === 'success') {
          updateService(
            service.id,
            {
              testState: 'ok',
              testMessage: result.value.message || '',
            },
            false,
          );
        } else if (result.status === 'error') {
          updateService(
            service.id,
            {
              testState: 'error',
              testMessage: result.message,
            },
            false,
          );
        } else {
          updateService(
            service.id,
            { testState: 'idle', testMessage: '' },
            false,
          );
        }
      })
      .catch((error: unknown) => {
        finishServiceTest(service.id, token);
        if (!currentServiceTest(service, token, run)) return;
        updateService(
          service.id,
          {
            testState: 'error',
            testMessage:
              error instanceof Error
                ? error.message
                : '服务连接测试失败。',
          },
          false,
        );
      });
  }

  function browseCli() {
    if (isBusy('cli-pick')) return;
    setCliBrowseError('');
    markBusy('cli-pick', true);
    const run = runRef.current;
    void capabilities
      .pickCliExecutable()
      .then((result) => {
        markBusy('cli-pick', false);
        if (!isMountedRun(run)) return;
        if (result.status === 'success') {
          setCliPath(result.value.path);
          setCliProbe((current) => ({
            ...current,
            state: 'idle',
            version: '',
            message: '',
            token: current.token + 1,
            source: 'idle',
            runtimeRevision: 0,
            runtimeFingerprint: '',
          }));
        } else if (result.status === 'error') {
          setCliBrowseError(result.message);
        }
      })
      .catch((error: unknown) => {
        markBusy('cli-pick', false);
        if (!isMountedRun(run)) return;
        setCliBrowseError(
          error instanceof Error
            ? error.message
            : '无法选择 Codex CLI 程序。',
        );
      });
  }

  function detectCli() {
    if (isBusy('cli-detect') || !cliPath.trim()) return;
    const run = runRef.current;
    const token = ++cliTokenRef.current;
    const testedPath = cliPath;
    setCliBrowseError('');
    setCliProbe({
      state: 'pending',
      version: '',
      message: '',
      token,
      source: 'detection',
      runtimeRevision: effectiveRuntimeRef.current?.revision ?? 0,
      runtimeFingerprint: effectiveRuntimeRef.current
        ? cliRuntimeFingerprint(effectiveRuntimeRef.current.cli)
        : '',
    });
    markBusy('cli-detect', true);
    void capabilities
      .detectCli({ path: testedPath })
      .then((result) => {
        markBusy('cli-detect', false);
        if (!isMountedRun(run)) return;
        setCliProbe((current) => {
          if (
            current.token !== token ||
            cliPathRef.current !== testedPath
          ) {
            return current;
          }
          if (result.status === 'success') {
            return {
              state: 'ok',
              version: result.value.version ?? '',
              message: result.value.message ?? '',
              token,
              source: 'detection',
              runtimeRevision: current.runtimeRevision,
              runtimeFingerprint: current.runtimeFingerprint,
            };
          }
          if (result.status === 'error') {
            return {
              state: 'error',
              version: '',
              message: result.message,
              token,
              source: 'detection',
              runtimeRevision: current.runtimeRevision,
              runtimeFingerprint: current.runtimeFingerprint,
            };
          }
          return {
            state: 'idle',
            version: '',
            message: '',
            token,
            source: 'detection',
            runtimeRevision: current.runtimeRevision,
            runtimeFingerprint: current.runtimeFingerprint,
          };
        });
      })
      .catch((error: unknown) => {
        markBusy('cli-detect', false);
        if (!isMountedRun(run)) return;
        setCliProbe((current) => {
          if (
            current.token !== token ||
            cliPathRef.current !== testedPath
          ) {
            return current;
          }
          return {
            state: 'error',
            version: '',
            message:
              error instanceof Error
                ? error.message
                : 'Codex CLI 检测失败。',
            token,
            source: 'detection',
            runtimeRevision: current.runtimeRevision,
            runtimeFingerprint: current.runtimeFingerprint,
          };
        });
      });
  }

  function startLogin() {
    if (authPending || busyRef.current.has('auth')) return;
    const run = runRef.current;
    setAuthError('');
    markBusy('auth', true);
    void capabilities
      .startChatGptLogin()
      .then((result) => {
        markBusy('auth', false);
        if (!isMountedRun(run)) return;
        if (result.status === 'error') {
          setAuthError(result.message);
        }
      })
      .catch((error: unknown) => {
        markBusy('auth', false);
        if (!isMountedRun(run)) return;
        setAuthError(
          error instanceof Error
            ? error.message
            : 'ChatGPT 登录失败。',
        );
      });
  }

  function logout() {
    if (authPending || busyRef.current.has('auth')) return;
    const run = runRef.current;
    setAuthError('');
    markBusy('auth', true);
    void capabilities
      .logoutChatGpt()
      .then((result) => {
        markBusy('auth', false);
        if (!isMountedRun(run)) return;
        if (result.status === 'error') {
          setAuthError(result.message);
        }
      })
      .catch((error: unknown) => {
        markBusy('auth', false);
        if (!isMountedRun(run)) return;
        setAuthError(
          error instanceof Error
            ? error.message
            : '无法退出 ChatGPT。',
        );
      });
  }

  function mergeScannedEnvironments(
    options: readonly ToolboxOption[],
    previous: Record<string, ToolboxEnvDraft>,
  ): Record<string, ToolboxEnvDraft> {
    const next = { ...previous };
    for (const option of options) {
      if (!next[option.id]) {
        next[option.id] = {
          path: '',
          state: 'idle',
          message: '',
          token: 0,
        };
      }
    }
    return next;
  }

  function scanToolboxes() {
    if (isBusy('toolbox-scan')) return;
    const run = runRef.current;
    const token = ++scanTokenRef.current;
    setScanState('loading');
    setScanError('');
    markBusy('toolbox-scan', true);
    void capabilities
      .scanToolboxes()
      .then((result) => {
        markBusy('toolbox-scan', false);
        if (!isMountedRun(run) || scanTokenRef.current !== token) {
          return;
        }
        if (result.status === 'success') {
          setToolboxes([...result.value]);
          setEnvDrafts((current) =>
            mergeScannedEnvironments(result.value, current),
          );
          setSelectedToolboxId((current) =>
            current &&
            result.value.some((item) => item.id === current)
              ? current
              : (result.value[0]?.id ?? null),
          );
          setScanState('ready');
        } else if (result.status === 'error') {
          setScanError(result.message);
          setScanState('error');
        } else {
          setScanState('idle');
        }
      })
      .catch((error: unknown) => {
        markBusy('toolbox-scan', false);
        if (!isMountedRun(run) || scanTokenRef.current !== token) {
          return;
        }
        setScanError(
          error instanceof Error
            ? error.message
            : '工具箱扫描失败。',
        );
        setScanState('error');
      });
  }

  function selectTab(next: SettingsTab) {
    setTab(next);
    if (next === 'toolboxes' && scanState === 'idle') {
      scanToolboxes();
    }
  }

  function updateEnv(
    toolboxId: string,
    patch: Partial<ToolboxEnvDraft>,
    resetState = true,
  ) {
    if (resetState) {
      envDetectTokensRef.current.set(
        toolboxId,
        (envDetectTokensRef.current.get(toolboxId) ?? 0) + 1,
      );
      envPickTokensRef.current.set(
        toolboxId,
        (envPickTokensRef.current.get(toolboxId) ?? 0) + 1,
      );
    }
    setEnvDrafts((current) => {
      const currentDraft = current[toolboxId] ?? {
        path: '',
        state: 'idle',
        message: '',
        token: 0,
      };
      return {
        ...current,
        [toolboxId]: {
          ...currentDraft,
          ...patch,
          ...(resetState && patch.state === undefined
            ? { state: 'idle', message: '' }
            : {}),
          token: resetState
            ? currentDraft.token + 1
            : (patch.token ?? currentDraft.token),
        },
      };
    });
  }

  function pickToolboxEnvironment(toolboxId: string) {
    if (isBusy(`toolbox-pick:${toolboxId}`)) return;
    const run = runRef.current;
    const token =
      (envPickTokensRef.current.get(toolboxId) ?? 0) + 1;
    envPickTokensRef.current.set(toolboxId, token);
    const basePath = envDrafts[toolboxId]?.path ?? '';
    setEnvPickErrors((current) => ({
      ...current,
      [toolboxId]: '',
    }));
    markBusy(`toolbox-pick:${toolboxId}`, true);
    void capabilities
      .pickToolboxEnvironment({ toolboxId })
      .then((result) => {
        markBusy(`toolbox-pick:${toolboxId}`, false);
        if (
          !isMountedRun(run) ||
          envPickTokensRef.current.get(toolboxId) !== token ||
          (envDrafts[toolboxId]?.path ?? '') !== basePath
        ) {
          return;
        }
        if (result.status === 'success') {
          updateEnv(toolboxId, {
            path: result.value.path,
            state: 'idle',
            message: '',
          });
        } else if (result.status === 'error') {
          setEnvPickErrors((current) => ({
            ...current,
            [toolboxId]: result.message,
          }));
        }
      })
      .catch((error: unknown) => {
        markBusy(`toolbox-pick:${toolboxId}`, false);
        if (!isMountedRun(run)) return;
        setEnvPickErrors((current) => ({
          ...current,
          [toolboxId]:
            error instanceof Error
              ? error.message
              : '无法选择运行环境目录。',
        }));
      });
  }

  function detectToolboxEnvironment(toolbox: ToolboxOption) {
    const draft = envDrafts[toolbox.id];
    if (
      !draft?.path.trim() ||
      isBusy(`toolbox-detect:${toolbox.id}`)
    ) {
      return;
    }
    const run = runRef.current;
    const token = ++envTokenRef.current;
    envDetectTokensRef.current.set(toolbox.id, token);
    const testedPath = draft.path;
    setEnvDrafts((current) => ({
      ...current,
      [toolbox.id]: {
        ...(current[toolbox.id] ?? draft),
        state: 'pending',
        message: '',
        token,
      },
    }));
    markBusy(`toolbox-detect:${toolbox.id}`, true);
    void capabilities
      .detectToolboxEnvironment({
        toolboxId: toolbox.id,
        path: testedPath,
      })
      .then((result) => {
        markBusy(`toolbox-detect:${toolbox.id}`, false);
        if (!isMountedRun(run)) return;
        setEnvDrafts((current) => {
          const currentDraft = current[toolbox.id];
          if (
            !currentDraft ||
            currentDraft.path !== testedPath ||
            envDetectTokensRef.current.get(toolbox.id) !== token
          ) {
            return current;
          }
          if (result.status === 'success') {
            return {
              ...current,
              [toolbox.id]: {
                ...currentDraft,
                state: 'ok',
                message: result.value.message || '',
              },
            };
          }
          if (result.status === 'error') {
            return {
              ...current,
              [toolbox.id]: {
                ...currentDraft,
                state: 'error',
                message: result.message,
              },
            };
          }
          return {
            ...current,
            [toolbox.id]: {
              ...currentDraft,
              state: 'idle',
              message: '',
            },
          };
        });
      })
      .catch((error: unknown) => {
        markBusy(`toolbox-detect:${toolbox.id}`, false);
        if (!isMountedRun(run)) return;
        setEnvDrafts((current) => {
          const currentDraft = current[toolbox.id];
          if (
            !currentDraft ||
            currentDraft.path !== testedPath ||
            envDetectTokensRef.current.get(toolbox.id) !== token
          ) {
            return current;
          }
          return {
            ...current,
            [toolbox.id]: {
              ...currentDraft,
              state: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : '运行环境检测失败。',
            },
          };
        });
      });
  }

  function save() {
    if (savingRef.current || busyRef.current.size > 0 || !snapshot) {
      return;
    }
    const invalidExisting = services.find(
      (service) =>
        !service.isNew &&
        Object.keys(validateServiceForSubmit(service)).length > 0,
    );
    if (invalidExisting) {
      setServices((current) =>
        current.map((service) =>
          service.id === invalidExisting.id
            ? {
                ...service,
                errors: validateServiceForSubmit(service),
              }
            : service,
        ),
      );
      setActiveServiceId(invalidExisting.id);
      setSaveError('请先修正标记的服务配置。');
      return;
    }
    const droppedNew = services.filter(
      (service) => service.isNew && !serviceIsValid(service),
    );
    const submitted = services.filter(
      (service) => !service.isNew || serviceIsValid(service),
    );
    const submittedIds = new Set(
      submitted.map((service) => service.id),
    );
    const requestedActiveId = currentActiveServiceId();
    const activeServiceId =
      requestedActiveId && submittedIds.has(requestedActiveId)
        ? requestedActiveId
        : (submitted[0]?.id ?? null);
    const payloadServices = submitted.map((service) => ({
      id: service.id,
      name: service.name.trim(),
      baseUrl: service.baseUrl.trim(),
      ...(service.keyValue.trim()
        ? { key: service.keyValue }
        : {}),
    }));
    const environmentList = Object.entries(envDrafts)
      .filter(([, draft]) => Boolean(draft.path.trim()))
      .map(([toolboxId, draft]) => ({
        toolboxId,
        environmentPath: draft.path,
      }));
    const run = runRef.current;
    savingRef.current = true;
    setSaveError('');
    markBusy('save', true);
    void capabilities
      .saveSettings({
        cli: { path: cliPath },
        models: {
          mode,
          activeServiceId,
          services: payloadServices,
        },
        toolboxes: { environments: environmentList },
      })
      .then((result) => {
        markBusy('save', false);
        savingRef.current = false;
        if (!isMountedRun(run)) return;
        if (result.status === 'success') {
          const droppedNames = droppedNew
            .map(
              (service) =>
                service.name.trim() || '未命名服务',
            )
            .join('、');
          onSaved(
            result.value,
            droppedNames
              ? `依赖设置已保存。未完成的服务「${droppedNames}」未保存。`
              : '依赖设置已保存。',
          );
        } else if (result.status === 'error') {
          setSaveError(result.message);
        } else {
          setSaveError('保存已取消。');
        }
      })
      .catch((error: unknown) => {
        markBusy('save', false);
        savingRef.current = false;
        if (!isMountedRun(run)) return;
        setSaveError(
          error instanceof Error
            ? error.message
            : '依赖设置保存失败。',
        );
      });
  }

  function currentActiveServiceId(): string | null {
    return activeServiceId;
  }

  const saving = isBusy('save');
  const canSave =
    Boolean(snapshot) &&
    !loading &&
    !loadError &&
    !saving &&
    !authPending &&
    !cancelServiceId &&
    busyRef.current.size === 0;
  const activeService =
    services.find((service) => service.id === activeServiceId) ??
    null;
  const cancelService = services.find(
    (service) => service.id === cancelServiceId,
  );
  const selectedToolbox =
    toolboxes.find((toolbox) => toolbox.id === selectedToolboxId) ??
    null;
  const selectedEnv = selectedToolbox
    ? envDrafts[selectedToolbox.id]
    : undefined;
  const canScan = tab === 'toolboxes' && !isBusy('toolbox-scan');
  const authEmail = account.email?.trim() || '账号邮箱未提供';

  function renderLoading(): ReactNode {
    return (
      <div className="settings-state" role="status">
        <span className="settings-state-spinner" aria-hidden="true" />
        <span>正在加载依赖设置…</span>
      </div>
    );
  }

  function renderLoadError(): ReactNode {
    return (
      <div className="settings-state settings-state--error" role="alert">
        <p>{loadError || '依赖设置加载失败。'}</p>
        <Button onClick={onRetryLoad}>重试</Button>
      </div>
    );
  }

  function renderCliPanel(): ReactNode {
    const pending = cliProbe.state === 'pending';
    const detecting = isBusy('cli-detect');
    return (
      <section
        className="settings-panel"
        id="settings-panel-cli"
        aria-labelledby="settings-panel-cli-title"
      >
        <h3 className="settings-panel-title" id="settings-panel-cli-title">
          Codex CLI
        </h3>
        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-cli-path">
            程序路径
          </label>
          <div className="settings-path-row">
            <input
              className="settings-input"
              id="settings-cli-path"
              type="text"
              placeholder="Codex CLI 可执行文件路径"
              autoComplete="off"
              spellCheck={false}
              value={cliPath}
              disabled={pending || isBusy('cli-pick')}
              onChange={(event) => {
                cliTokenRef.current += 1;
                setCliPath(event.target.value);
                setCliProbe((current) => ({
                  ...current,
                  state: 'idle',
                  version: '',
                  message: '',
                  token: current.token + 1,
                  source: 'idle',
                  runtimeRevision: 0,
                  runtimeFingerprint: '',
                }));
                setCliBrowseError('');
              }}
            />
            <Button
              disabled={pending || isBusy('cli-pick') || saving}
              onClick={browseCli}
            >
              {isBusy('cli-pick') ? '选择中…' : '浏览'}
            </Button>
          </div>
          {cliBrowseError ? (
            <p className="settings-field-error" role="alert">
              {cliBrowseError}
            </p>
          ) : null}
        </div>
        <div className="settings-actions">
          <Button
            disabled={
              !cliPath.trim() ||
              pending ||
              detecting ||
              saving ||
              isBusy('cli-pick')
            }
            onClick={detectCli}
          >
            {pending || detecting ? '正在检测…' : '检测并连接'}
          </Button>
        </div>
        {cliPath.trim() || cliProbe.state !== 'idle' ? (
          <div
            className="settings-result"
            data-state={cliProbe.state}
            role="status"
            data-source={cliProbe.source}
          >
            <span className="settings-result-badge">
              {cliStateLabel(cliProbe.state)}
            </span>
            {cliProbe.version || cliProbe.message ? (
              <div className="settings-result-body">
                {cliProbe.version ? (
                  <p className="settings-result-title">版本：{cliProbe.version}</p>
                ) : null}
                {cliProbe.message ? (
                  <p className="settings-result-note">{cliProbe.message}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  function renderChatGptPanel(): ReactNode {
    const pending = authPending;
    const displayedAuthError =
      authError || account.message || '';
    return (
      <div
        className="settings-mode-panel"
        id="settings-mode-chatgpt"
        role="tabpanel"
        aria-labelledby="settings-mode-chatgpt-tab"
      >
        {account.status === 'logged-in' ? (
          <>
            <div className="settings-account">
              <span className="settings-badge is-ok">已登录</span>
              <span className="settings-account-email">{authEmail}</span>
            </div>
            <div className="settings-actions">
              <Button disabled={pending} onClick={logout}>
                {pending ? '正在退出…' : '退出登录'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="settings-actions">
              <Button disabled={pending} onClick={startLogin}>
                {pending
                  ? '正在登录…'
                  : displayedAuthError
                    ? '重新登录 ChatGPT'
                    : '登录 ChatGPT'}
              </Button>
            </div>
            {pending ? (
              <p className="settings-login-note">取消设置会结束本次授权。</p>
            ) : null}
          </>
        )}
        {displayedAuthError ? (
          <p className="settings-field-error" role="alert">
            {displayedAuthError}
          </p>
        ) : null}
      </div>
    );
  }

  function renderServiceEditor(): ReactNode {
    if (!activeService) return null;
    const service = activeService;
    const errors = fieldErrorFor(service);
    const testPending = isBusy(`service-test:${service.id}`) ||
      service.testState === 'pending';
    return (
      <div className="settings-service-editor">
        <div className="settings-field">
          <label
            className="settings-label"
            htmlFor="settings-service-name"
          >
            服务名称
          </label>
          <input
            ref={serviceNameRef}
            className={`settings-input${errors.name ? ' is-invalid' : ''}`}
            id="settings-service-name"
            type="text"
            value={service.name}
            onChange={(event) => {
              updateService(service.id, {
                name: event.target.value,
                errors: { ...service.errors, name: undefined },
              });
            }}
          />
          {errors.name ? (
            <p className="settings-field-error" role="alert">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="settings-field">
          <label
            className="settings-label"
            htmlFor="settings-service-url"
          >
            API 地址
          </label>
          <input
            className={`settings-input${errors.baseUrl ? ' is-invalid' : ''}`}
            id="settings-service-url"
            type="text"
            value={service.baseUrl}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              updateService(service.id, {
                baseUrl: event.target.value,
                errors: { ...service.errors, baseUrl: undefined },
              });
            }}
          />
          {errors.baseUrl ? (
            <p className="settings-field-error" role="alert">
              {errors.baseUrl}
            </p>
          ) : null}
        </div>
        <div className="settings-field">
          <label
            className="settings-label"
            htmlFor="settings-service-key"
          >
            API Key
          </label>
          <div className="settings-key-row">
            <input
              className={`settings-input${errors.key ? ' is-invalid' : ''}`}
              id="settings-service-key"
              type={keyVisible ? 'text' : 'password'}
              value={service.keyValue}
              placeholder={
                service.hasKey
                  ? '已保存密钥（留空保持原密钥）'
                  : '输入 API Key'
              }
              autoComplete="new-password"
              spellCheck={false}
              onChange={(event) => {
                updateService(service.id, {
                  keyValue: event.target.value,
                  errors: { ...service.errors, key: undefined },
                });
              }}
            />
            <Button
              className="settings-key-toggle"
              onClick={() => setKeyVisible((current) => !current)}
            >
              {keyVisible ? '隐藏' : '显示'}
            </Button>
          </div>
          {errors.key ? (
            <p className="settings-field-error" role="alert">
              {errors.key}
            </p>
          ) : null}
        </div>
        <div className="settings-actions">
          <Button
            disabled={testPending || saving}
            onClick={() => testService(service)}
          >
            {testPending ? '正在测试…' : '测试连接'}
          </Button>
          {service.isNew ? (
            <Button disabled={saving} onClick={requestCancelNewService}>
              取消添加
            </Button>
          ) : null}
        </div>
        {service.testState !== 'idle' ? (
          <div
            className="settings-result"
            data-state={service.testState}
            role="status"
          >
            <span className="settings-result-badge">
              {service.testState === 'pending'
                ? '测试中'
                : service.testState === 'ok'
                  ? '连接成功'
                  : '连接失败'}
            </span>
            {service.testMessage ? (
              <p className="settings-result-note">{service.testMessage}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderModelsPanel(): ReactNode {
    return (
      <section
        className="settings-panel"
        id="settings-panel-models"
        aria-labelledby="settings-panel-models-title"
      >
        <h3
          className="settings-panel-title"
          id="settings-panel-models-title"
        >
          模型服务
        </h3>
        <div
          className="settings-segmented"
          role="tablist"
          aria-label="模型服务接入方式"
        >
          <button
            type="button"
            id="settings-mode-chatgpt-tab"
            role="tab"
            className={`settings-segment${mode === 'chatgpt' ? ' is-active' : ''}`}
            aria-selected={mode === 'chatgpt'}
            aria-controls="settings-mode-chatgpt"
            onClick={() => setMode('chatgpt')}
          >
            ChatGPT 登录
          </button>
          <button
            type="button"
            id="settings-mode-api-tab"
            role="tab"
            className={`settings-segment${mode === 'api' ? ' is-active' : ''}`}
            aria-selected={mode === 'api'}
            aria-controls="settings-mode-api"
            onClick={() => setMode('api')}
          >
            自定义 API
          </button>
        </div>
        {effectiveRuntime?.models &&
        effectiveRuntime.models.state !== 'inactive' ? (
          <div
            className="settings-result"
            data-state={
              effectiveRuntime.models.state === 'ready'
                ? 'ok'
                : effectiveRuntime.models.state === 'error'
                  ? 'error'
                  : 'pending'
            }
            role="status"
          >
            <span className="settings-result-badge">
              {modelRuntimeLabel(effectiveRuntime.models.state)}
            </span>
            {effectiveRuntime.models.message ? (
              <p className="settings-result-note">{effectiveRuntime.models.message}</p>
            ) : null}
          </div>
        ) : null}
        {mode === 'chatgpt'
          ? renderChatGptPanel()
          : (
            <div
              className="settings-mode-panel"
              id="settings-mode-api"
              role="tabpanel"
              aria-labelledby="settings-mode-api-tab"
            >
              {services.length > 0 ? (
                <ul
                  className="settings-service-list"
                  aria-label="自定义 API 服务"
                >
                  {services.map((service) => (
                    <li
                      className={`settings-service-item${service.id === activeServiceId ? ' is-active' : ''}`}
                      key={service.id}
                    >
                      <button
                        type="button"
                        className="settings-service-select"
                        aria-pressed={service.id === activeServiceId}
                        onClick={() => selectService(service.id)}
                      >
                        <span className="settings-service-name">
                          {service.name.trim() || '未命名服务'}
                          {service.id === activeServiceId ? (
                            <span className="settings-badge">当前</span>
                          ) : null}
                          {service.isNew ? (
                            <span className="settings-badge is-warn">
                              草稿
                            </span>
                          ) : null}
                        </span>
                        <span className="settings-service-url">
                          {service.baseUrl.trim() || '未填写 API 地址'}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="settings-service-remove"
                        aria-label={`删除服务 ${service.name.trim() || '未命名服务'}`}
                        onClick={() => removeService(service.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="settings-empty">尚未添加自定义 API。</div>
              )}
              <div className="settings-actions">
                <Button disabled={saving} onClick={addService}>
                  添加服务
                </Button>
              </div>
              {renderServiceEditor()}
            </div>
          )}
      </section>
    );
  }

  function renderToolboxesPanel(): ReactNode {
    const scanPending = scanState === 'loading';
    return (
      <section
        className="settings-panel"
        id="settings-panel-toolboxes"
        aria-labelledby="settings-panel-toolboxes-title"
      >
        <div className="settings-panel-head">
          <div>
            <h3
              className="settings-panel-title"
              id="settings-panel-toolboxes-title"
            >
              Flamelet 工具箱
            </h3>
          </div>
          <Button
            disabled={!canScan || saving}
            onClick={scanToolboxes}
          >
            {scanPending ? '扫描中…' : '刷新'}
          </Button>
        </div>
        {scanState === 'loading' ? (
          <span className="visually-hidden" role="status">正在扫描工具箱…</span>
        ) : scanState === 'error' ? (
          <div className="settings-state settings-state--inline settings-state--error" role="alert">
            <p>{scanError || '工具箱扫描失败。'}</p>
            <Button onClick={scanToolboxes}>重试</Button>
          </div>
        ) : scanState === 'ready' && toolboxes.length === 0 ? (
          <div className="settings-empty">
            <span>未发现可用工具箱。</span>
          </div>
        ) : toolboxes.length > 0 ? (
          <>
            <ul className="settings-toolbox-list">
              {toolboxes.map((toolbox) => {
                const draft = envDrafts[toolbox.id];
                const badge = toolboxBadgeLabel(draft);
                return (
                  <li
                    className={`settings-toolbox-item${toolbox.id === selectedToolboxId ? ' is-active' : ''}`}
                    key={toolbox.id}
                  >
                    <button
                      type="button"
                      className="settings-toolbox-select"
                      aria-pressed={toolbox.id === selectedToolboxId}
                      onClick={() => setSelectedToolboxId(toolbox.id)}
                    >
                      <span className="settings-toolbox-name">
                        {toolbox.label}
                      </span>
                      {toolbox.id !== toolbox.label ? (
                        <span className="settings-toolbox-id">
                          {toolbox.id}
                        </span>
                      ) : null}
                      {toolbox.error ? (
                        <span className="settings-toolbox-error" role="alert">
                          {toolbox.error}
                        </span>
                      ) : null}
                    </button>
                    {toolbox.id !== selectedToolboxId || !draft?.path.trim() ? (
                      <span className={statusBadgeTone(draft?.state)}>{badge}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {selectedToolbox ? (
              <div className="settings-toolbox-env">
                <div className="settings-field">
                  <label
                    className="settings-label"
                    htmlFor="settings-toolbox-path"
                  >
                    运行环境
                  </label>
                  <div className="settings-path-row">
                    <input
                      className="settings-input"
                      id="settings-toolbox-path"
                      type="text"
                      value={selectedEnv?.path ?? ''}
                      placeholder="选择运行环境目录"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        updateEnv(selectedToolbox.id, {
                          path: event.target.value,
                        });
                      }}
                    />
                    <Button
                      disabled={
                        saving ||
                        isBusy(`toolbox-pick:${selectedToolbox.id}`)
                      }
                      onClick={() =>
                        pickToolboxEnvironment(selectedToolbox.id)
                      }
                    >
                      {isBusy(`toolbox-pick:${selectedToolbox.id}`)
                        ? '选择中…'
                        : '选择'}
                    </Button>
                  </div>
                  {envPickErrors[selectedToolbox.id] ? (
                    <p className="settings-field-error" role="alert">
                      {envPickErrors[selectedToolbox.id]}
                    </p>
                  ) : null}
                </div>
                <div className="settings-actions">
                  <Button
                    disabled={
                      !selectedEnv?.path.trim() ||
                      selectedEnv?.state === 'pending' ||
                      saving
                    }
                    onClick={() =>
                      detectToolboxEnvironment(selectedToolbox)
                    }
                  >
                    {selectedEnv?.state === 'pending'
                      ? '正在检测…'
                      : '检测环境'}
                  </Button>
                </div>
                {selectedEnv?.path.trim() ? (
                  <div className="settings-result" data-state={selectedEnv.state} role="status">
                    <span className="settings-result-badge">
                      {toolboxBadgeLabel(selectedEnv)}
                    </span>
                    {selectedEnv.message ? (
                      <p className="settings-result-note">{selectedEnv.message}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <Modal
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen) requestClose();
        }}
        title="依赖设置"
        id="settings-dialog"
        initialFocusRef={firstTabRef}
        returnFocusTarget={returnFocusTarget}
        closeOnOverlayClick={!saving}
        closeOnEscape={!saving}
        className="settings-dialog"
        footer={
          <>
            {saveError ? (
              <p className="settings-footer-error" role="alert">
                {saveError}
              </p>
            ) : null}
            <Button
              disabled={saving}
              onClick={requestClose}
              className="settings-cancel"
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!canSave}
              onClick={save}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <fieldset
          className="settings-body"
          disabled={saving}
          aria-busy={saving}
        >
          <nav className="settings-nav" aria-label="设置分类">
            <button
              ref={firstTabRef}
              type="button"
              className={`settings-nav-item${tab === 'cli' ? ' is-active' : ''}`}
              aria-current={tab === 'cli' ? 'true' : undefined}
              aria-controls="settings-panel-cli"
              onClick={() => selectTab('cli')}
            >
              Codex CLI
            </button>
            <button
              type="button"
              className={`settings-nav-item${tab === 'models' ? ' is-active' : ''}`}
              aria-current={tab === 'models' ? 'true' : undefined}
              aria-controls="settings-panel-models"
              onClick={() => selectTab('models')}
            >
              模型服务
            </button>
            <button
              type="button"
              className={`settings-nav-item${tab === 'toolboxes' ? ' is-active' : ''}`}
              aria-current={tab === 'toolboxes' ? 'true' : undefined}
              aria-controls="settings-panel-toolboxes"
              onClick={() => selectTab('toolboxes')}
            >
              Flamelet 工具箱
            </button>
          </nav>
          <div className="settings-content">
            {loading && !snapshot ? (
              renderLoading()
            ) : loadError ? (
              renderLoadError()
            ) : !snapshot ? null : tab === 'cli' ? (
              renderCliPanel()
            ) : tab === 'models' ? (
              renderModelsPanel()
            ) : (
              renderToolboxesPanel()
            )}
          </div>
        </fieldset>
      </Modal>

      <Modal
        open={Boolean(cancelService)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setCancelServiceId(null);
        }}
        title="放弃未完成的服务？"
        description={
          <>
            放弃「{cancelService?.name.trim() || '未命名服务'}」将丢弃已输入的内容。
          </>
        }
        variant="compact"
        closeOnOverlayClick={false}
        className="settings-confirm-dialog"
        footer={
          <>
            <Button onClick={() => setCancelServiceId(null)}>
              继续编辑
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (cancelServiceId) {
                  performRemoveService(cancelServiceId);
                }
              }}
            >
              放弃并移除
            </Button>
          </>
        }
      />
    </>
  );
}
