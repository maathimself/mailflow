import { folderParentLabel } from '../utils/folderDisplay';

// Folder name prefixed with its muted ancestor path ("Personal / Insurance"),
// used by every move-to-folder picker so duplicate names under different
// parents stay distinguishable. The parent shrinks/truncates first; the name
// itself only truncates once the parent is fully collapsed.
export default function FolderPathLabel({ folder }) {
  const parent = folderParentLabel(folder);
  return (
    <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
      {parent && (
        <span style={{ color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, minWidth: 0 }}>
          {parent}{' / '}
        </span>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {folder.name || folder.path}
      </span>
    </span>
  );
}
