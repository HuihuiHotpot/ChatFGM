"""根据 Tmax 和 T(Z) 的 RMS 决定是否写出 profile。"""

import numpy as np
import cantera as ct

from ember.output import StateWriter


class TriggeredStateWriter:
    """满足 Tmax 或 T(Z) RMS 条件时调用 Ember 原生 ``StateWriter``。"""

    def __init__(self, solver, options, delta_T_save, rms_T_save, n_Z):

        self.solver = solver
        self.writer = StateWriter(solver, options)

        self.delta_T_save = float(delta_T_save)
        self.rms_T_save = float(rms_T_save)

        self.Z_grid = np.linspace(0.0, 1.0, n_Z)
        self.prepare_mixture_fraction(options)

        # 上一次真正保存 profile 时的状态。
        self.last_saved_Tmax = None
        self.last_saved_T_on_Z = None

        # 用于强制保存最终状态。
        self.force_next = False

    def prepare_mixture_fraction(self, options):
        """准备由物种质量分数Y计算Bilger混合分数Z所需的数据。"""

        gas = ct.Solution(
            options.chemistry.mechanismFile,
            options.chemistry.phaseID,
            transport_model=None,
        )

        elements = ("C", "H", "O")
        A = np.array([
            [gas.n_atoms(i, e) * gas.atomic_weight(e) / gas.molecular_weights[i]
             for i in range(gas.n_species)]
            for e in elements
        ])

        wc = gas.atomic_weight("C")
        wh = gas.atomic_weight("H")
        wo = gas.atomic_weight("O")

        # 对任意质量分数Y：
        #
        # beta = beta_coefficients @ Y
        #
        # 就可以计算Bilger beta。
        self.beta_coefficients = (
            2.0 * A[0] / wc
            + 0.5 * A[1] / wh
            - A[2] / wo
        )

        # 计算燃料侧Bilger beta。
        gas.TPX = (
            options.initialCondition.Tfuel,
            options.initialCondition.pressure,
            options.initialCondition.fuel,
        )

        self.beta_fuel = float(
            self.beta_coefficients @ gas.Y
        )

        # 计算氧化剂侧Bilger beta。
        gas.TPX = (
            options.initialCondition.Toxidizer,
            options.initialCondition.pressure,
            options.initialCondition.oxidizer,
        )

        self.beta_oxidizer = float(
            self.beta_coefficients @ gas.Y
        )

    def temperature_on_Z_grid(self, temperature, mass_fractions):
        """把当前温度曲线插值到固定的 Z 网格。"""

        beta_current = (
            self.beta_coefficients
            @ mass_fractions
        )

        Z = (
            (beta_current - self.beta_oxidizer)
            / (self.beta_fuel - self.beta_oxidizer)
        )

        # np.interp 要求横坐标从小到大排列。
        order = np.argsort(Z)
        Z_sorted = Z[order]
        T_sorted = temperature[order]

        # 删除重复 Z，避免插值时同一 Z 对应多个网格点。
        Z_unique, unique_indices = np.unique(
            Z_sorted,
            return_index=True,
        )
        T_unique = T_sorted[unique_indices]

        return np.interp(
            self.Z_grid,
            Z_unique,
            T_unique,
        )

    def force_next_profile(self):
        """强制保留下一个无文件名的正常 profile，用于最终状态。"""

        self.force_next = True

    def current_metrics(self):
        """计算Tmax和固定Z网格上的温度曲线。"""

        current_T = np.asarray(self.solver.T)
        current_Y = np.asarray(self.solver.Y)

        current_Tmax = float(np.max(current_T))

        current_T_on_Z = self.temperature_on_Z_grid(
            current_T,
            current_Y,
        )

        return current_Tmax, current_T_on_Z

    def save_initial_profile(self, name, error_file):
        """保存第一条 profile，并建立后续判断基准。"""

        (
            initial_Tmax,
            initial_T_on_Z,
        ) = self.current_metrics()

        # 调用 Ember 原生 StateWriter，真正写入文件。
        result = self.writer(name, error_file)

        self.last_saved_Tmax = initial_Tmax
        self.last_saved_T_on_Z = initial_T_on_Z.copy()

        return result

    def __call__(self, name, error_file=False):
        """
        Ember 每次准备写 profile 时都会调用这个函数。

        返回 self.writer(...) 表示真正写文件；
        返回 None 表示跳过这一次保存。
        """

        # profNow、debug和error等带名字的文件不参与筛选。
        # 它们也不改变正常编号 profile 的判断基准。
        if name or error_file:
            return self.writer(name, error_file)

        # 第一次调用时，保存初始 profile，
        # 同时把当前温度场记录为初始混合线。
        if self.last_saved_T_on_Z is None:
            self.force_next = False
            return self.save_initial_profile(
                name,
                error_file,
            )

        (
            current_Tmax,
            current_T_on_Z,
        ) = self.current_metrics()

        # -------------------------------------------------
        # 条件一：Tmax相对于上一次保存值的变化
        # -------------------------------------------------

        delta_Tmax = abs(
            current_Tmax
            - self.last_saved_Tmax
        )

        temperature_triggered = (
                delta_Tmax
                >= self.delta_T_save
        )

        # -------------------------------------------------
        # 条件二：整条T(Z)曲线相对于上一次保存曲线的RMS
        # -------------------------------------------------
        delta_T_on_Z = (
            current_T_on_Z
            - self.last_saved_T_on_Z
        )

        temperature_rms = float(
            np.sqrt(np.mean(delta_T_on_Z**2))
        )

        rms_triggered = (
            temperature_rms
            >= self.rms_T_save
        )

        # -------------------------------------------------
        # 综合全部触发条件
        # -------------------------------------------------

        save_current = (
                self.force_next
                or temperature_triggered
                or rms_triggered
        )

        self.force_next = False

        if not save_current:
            # 不调用原生 StateWriter，因此不写文件。
            return None

        # 只有运行这一句时，才真正写出 profile 文件。
        result = self.writer(name, error_file)

        # 文件写完后，更新“上一次保存”的所有基准。
        self.last_saved_Tmax = current_Tmax
        self.last_saved_T_on_Z = current_T_on_Z.copy()

        return result


class TriggeredStateWriterFactory:
    """保存自定义 StateWriter 所需的参数。"""

    def __init__(self, delta_T_save, rms_T_save, n_Z):
        self.delta_T_save = delta_T_save
        self.rms_T_save = rms_T_save
        self.n_Z = n_Z

    def __call__(self, solver, options):
        """Ember 创建求解器时调用，生成真正的条件 writer。"""

        return TriggeredStateWriter(
            solver=solver,
            options=options,
            delta_T_save=self.delta_T_save,
            rms_T_save=self.rms_T_save,
            n_Z=self.n_Z,
        )