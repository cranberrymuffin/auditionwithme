export default function BackButton({
  onClick,
  label = "Back",
  className = "",
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={`flow-back ${className}`}>
      <span aria-hidden="true">←</span>
      {label}
    </button>
  );
}
