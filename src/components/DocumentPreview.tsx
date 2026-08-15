export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentPreview({
  src,
  fileName,
  fileSize,
}: {
  src: string;
  fileName: string;
  fileSize?: number;
}) {
  return (
    <figure className="document-panel" aria-label={`Document preview of ${fileName}`}>
      <figcaption>
        <span>Document preview</span>
        <span>Page 1</span>
      </figcaption>
      <div className="document-frame">
        <embed
          src={`${src}#page=1&toolbar=0&navpanes=0&scrollbar=0`}
          type="application/pdf"
          title={`Preview of ${fileName}`}
        />
      </div>
      <p>
        <strong>{fileName}</strong>
        <span>Read-only preview{fileSize != null ? ` · ${formatFileSize(fileSize)}` : ""}</span>
      </p>
    </figure>
  );
}
