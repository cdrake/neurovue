import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  Brain,
  FileJson,
  Folder,
  FolderOpen,
  Laptop,
  LoaderCircle,
  PackageOpen,
  Shapes,
  X,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { isBundlePath, isDocumentPath } from '../domain/bundle'
import { recentDatasetLabel } from '../hooks/useRecentDatasets'

// Shown in place of the workbench whenever no dataset is open: at launch
// (unless the last dataset is reopened, as VS Code does with its last
// folder) and after an open that left nothing loaded. While the app is still
// starting or reopening, it shows only what it is waiting on, so a relaunch
// that restores a dataset doesn't flash the full Welcome screen.
export function WelcomeScreen({
  busy,
  openingLabel,
  recentDatasets,
  reopenLast,
  onOpenBundle,
  onOpenFile,
  onOpenFolder,
  onOpenMesh,
  onOpenRecent,
  onOpenSample,
  onRemoveRecent,
  onReopenLastChange,
  onReceive,
  onClearStoredData,
}: {
  busy: boolean
  /** Set while starting up or reopening: what the app is waiting on. */
  openingLabel: string | null
  recentDatasets: readonly string[]
  reopenLast: boolean
  onOpenBundle: () => void
  onOpenFile: () => void
  /** Absent where there is no folder picker (iOS). */
  onOpenFolder?: () => void
  onOpenMesh: () => void
  onOpenRecent: (path: string) => void
  /** Null when this build ships no sample. */
  onOpenSample: (() => void) | null
  onRemoveRecent: (path: string) => void
  onReopenLastChange: (reopen: boolean) => void
  /** Set on an iPad not yet receiving sends from a Mac. */
  onReceive?: () => void
  /** Absent where NeuroVue keeps no files of its own (the web build). */
  onClearStoredData?: () => void
}): JSX.Element {
  if (openingLabel !== null) {
    return (
      <section className="nv-welcome" aria-busy="true" aria-label="Welcome">
        <p className="nv-welcome-opening">
          <LoaderCircle aria-hidden="true" className="nv-spin" size={16} />
          {openingLabel}
        </p>
      </section>
    )
  }

  return (
    <section className="nv-welcome" aria-labelledby="nv-welcome-title">
      <div className="nv-welcome-inner">
        <header className="nv-welcome-header">
          <h2 id="nv-welcome-title">Welcome to NeuroVue</h2>
          <p>Open a NIfTI volume or a BIDS dataset to start.</p>
          <p className="nv-welcome-disclaimer" role="note">
            For research use only. Not for clinical diagnosis.
          </p>
        </header>

        <div className="nv-welcome-columns">
          <section aria-labelledby="nv-welcome-start">
            <h3 id="nv-welcome-start">Start</h3>
            <div className="nv-welcome-actions">
              {onOpenFolder && (
                <WelcomeAction
                  className="nv-desktop-only"
                  disabled={busy}
                  hint="A folder of NIfTI volumes, such as a BIDS dataset"
                  icon={<FolderOpen aria-hidden="true" size={16} />}
                  label="Open folder…"
                  onClick={onOpenFolder}
                />
              )}
              <WelcomeAction
                disabled={busy}
                hint="A single .nii or .nii.gz volume"
                icon={<FileJson aria-hidden="true" size={16} />}
                label="Open NIfTI file…"
                onClick={onOpenFile}
              />
              <WelcomeAction
                disabled={busy}
                hint="A surface: GIfTI, MZ3, OBJ, STL, FreeSurfer…"
                icon={<Shapes aria-hidden="true" size={16} />}
                label="Open mesh…"
                onClick={onOpenMesh}
              />
              <WelcomeAction
                disabled={busy}
                hint="A .nvb, with the view it was saved with"
                icon={<PackageOpen aria-hidden="true" size={16} />}
                label="Open bundle…"
                onClick={onOpenBundle}
              />
              {onOpenSample ? (
                <WelcomeAction
                  disabled={busy}
                  hint="The MNI152 template that ships with NeuroVue"
                  icon={<Brain aria-hidden="true" size={16} />}
                  label="Open sample data"
                  onClick={onOpenSample}
                />
              ) : null}
              {onReceive ? (
                <WelcomeAction
                  disabled={busy}
                  hint="Lets a Mac running NeuroVue send here. Accept only sends whose code matches the Mac's."
                  icon={<Laptop aria-hidden="true" size={16} />}
                  label="Receive from a Mac"
                  onClick={onReceive}
                />
              ) : null}
            </div>
          </section>

          <section aria-labelledby="nv-welcome-recent">
            <h3 id="nv-welcome-recent">Recent</h3>
            {recentDatasets.length > 0 ? (
              <ul className="nv-welcome-recents">
                {recentDatasets.map((path) => (
                  <li key={path}>
                    <button
                      className="nv-welcome-recent"
                      disabled={busy}
                      onClick={() => onOpenRecent(path)}
                      title={path}
                      type="button"
                    >
                      <RecentIcon path={path} />
                      <span className="nv-welcome-recent-text">
                        <strong>{recentDatasetLabel(path)}</strong>
                        <small>{path}</small>
                      </span>
                    </button>
                    <button
                      aria-label={`Remove ${path} from recents`}
                      className="nv-welcome-recent-remove"
                      onClick={() => onRemoveRecent(path)}
                      title="Remove from recents"
                      type="button"
                    >
                      <X aria-hidden="true" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="nv-welcome-empty">
                Datasets you open will appear here.
              </p>
            )}
          </section>
        </div>

        <label className="nv-welcome-reopen">
          <input
            checked={reopenLast}
            onChange={(event) => onReopenLastChange(event.target.checked)}
            type="checkbox"
          />
          Reopen the last dataset when NeuroVue starts
        </label>
        {onClearStoredData ? (
          <button
            className="nv-welcome-clear"
            disabled={busy}
            onClick={onClearStoredData}
            type="button"
          >
            Clear stored data…
          </button>
        ) : null}
        <a
          className="nv-welcome-privacy"
          href="https://cdrake.github.io/neurovue/privacy"
          onClick={(event) => {
            // The app's webview won't follow external links; the system browser opens it.
            if (!isTauri()) return
            event.preventDefault()
            void invoke('open_privacy_policy')
          }}
          rel="noopener"
          target="_blank"
        >
          Privacy policy
        </a>
      </div>
    </section>
  )
}

function WelcomeAction({
  className,
  disabled,
  hint,
  icon,
  label,
  onClick,
}: {
  className?: string
  disabled: boolean
  hint: string
  icon: ReactNode
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className={`nv-welcome-action ${className ?? ''}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </button>
  )
}

function RecentIcon({ path }: { path: string }): JSX.Element {
  if (isBundlePath(path) || isDocumentPath(path))
    return <PackageOpen aria-hidden="true" size={15} />
  if (/\.nii(\.gz)?$/i.test(path)) {
    return <FileJson aria-hidden="true" size={15} />
  }
  return <Folder aria-hidden="true" size={15} />
}
