import './FileName.css';

export function FileName({ name, className }: { name: string; className?: string }) {
  const characters = Array.from(name);
  const split = characters.length > 16 ? characters.length - 8 : characters.length;

  return (
    <span className={className ? `file-name ${className}` : 'file-name'}>
      <span className="file-name-start">{characters.slice(0, split).join('')}</span>
      {split < characters.length ? (
        <span className="file-name-end">{characters.slice(split).join('')}</span>
      ) : null}
    </span>
  );
}
