import type { Ref } from 'react';
import type {
  BinaryResource,
  H5Dataset,
  H5DatasetRange,
  ListH5DatasetsInput,
  ReadBinaryResourceInput,
  ReadH5RangeInput,
  ServiceResult,
} from '../../services/capabilities';
import type {
  CsvViewState,
  H5ViewState,
  ImageViewState,
  OpenDocument,
  TextViewState,
} from '../../state/workspace';
import { CodeEditor } from './CodeEditor';
import { CsvViewer } from './CsvViewer';
import { H5Viewer } from './H5Viewer';
import { HtmlViewer } from './HtmlViewer';
import { ImageViewer } from './ImageViewer';
import type { ImageViewerHandle } from './ImageViewer';
import { MarkdownViewer } from './MarkdownViewer';

export interface DocumentViewerProps {
  projectId: string;
  document: OpenDocument;
  active: boolean;
  readBinaryResource?: (
    input: ReadBinaryResourceInput,
  ) => Promise<ServiceResult<BinaryResource>>;
  listH5Datasets?: (
    input: ListH5DatasetsInput,
  ) => Promise<ServiceResult<{
    datasets: readonly H5Dataset[];
    fileInfo?: string;
  }>>;
  readH5DatasetRange?: (
    input: ReadH5RangeInput,
  ) => Promise<ServiceResult<H5DatasetRange>>;
  onChange: (content: string) => void;
  onTextViewChange: (patch: Partial<TextViewState>) => void;
  onPreviewScroll: (scrollTop: number) => void;
  onImageViewChange: (patch: Partial<ImageViewState>) => void;
  onCsvViewChange: (patch: Partial<CsvViewState>) => void;
  onH5ViewChange: (patch: Partial<H5ViewState>) => void;
  onCopyValue: (value: string) => void;
  imageRef?: Ref<ImageViewerHandle>;
  onRefreshHtml: () => void;
}

export function DocumentViewer({
  projectId,
  document,
  active,
  readBinaryResource,
  listH5Datasets,
  readH5DatasetRange,
  onChange,
  onTextViewChange,
  onPreviewScroll,
  onImageViewChange,
  onCsvViewChange,
  onH5ViewChange,
  onCopyValue,
  imageRef,
  onRefreshHtml,
}: DocumentViewerProps) {
  if (document.viewerKind === 'csv') {
    return (
      <CsvViewer
        document={document}
        active={active}
        onViewChange={onCsvViewChange}
        onCopyValue={onCopyValue}
      />
    );
  }

  if (document.viewerKind === 'html') {
    return (
      <HtmlViewer
        document={document}
        active={active}
        onRefresh={onRefreshHtml}
      />
    );
  }

  if (document.viewerKind === 'h5') {
    return (
      <H5Viewer
        projectId={projectId}
        document={document}
        active={active}
        sourceRevision={document.externalRevision}
        listH5Datasets={listH5Datasets}
        readH5DatasetRange={readH5DatasetRange}
        onViewChange={onH5ViewChange}
        onCopyValue={onCopyValue}
      />
    );
  }

  if (document.viewerKind === 'image') {
    return (
      <ImageViewer
        ref={imageRef}
        projectId={projectId}
        document={document}
        active={active}
        sourceRevision={document.externalRevision}
        readBinaryResource={readBinaryResource}
        onViewStateChange={onImageViewChange}
      />
    );
  }

  if (document.viewerKind === 'markdown') {
    return (
      <MarkdownViewer
        projectId={projectId}
        document={document}
        active={active}
        readBinaryResource={readBinaryResource}
        onChange={onChange}
        onTextViewChange={onTextViewChange}
        onPreviewScroll={onPreviewScroll}
      />
    );
  }

  return (
    <CodeEditor
      document={document}
      active={active}
      onChange={onChange}
      onTextViewChange={onTextViewChange}
    />
  );
}
