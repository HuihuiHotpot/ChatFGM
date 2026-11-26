export function LeftPanelIcon() {
  return (
    <svg
      className="icon-button-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="2.2"
        y="3.2"
        width="11.6"
        height="9.6"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M6.4 4.4v7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="3.1"
        y="4.4"
        width="3.3"
        height="7.2"
        rx="0.7"
        fill="currentColor"
        fillOpacity="0.3"
      />
    </svg>
  );
}

export function RightPanelIcon() {
  return (
    <svg
      className="icon-button-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="2.2"
        y="3.2"
        width="11.6"
        height="9.6"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M9.6 4.4v7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="9.6"
        y="4.4"
        width="3.3"
        height="7.2"
        rx="0.7"
        fill="currentColor"
        fillOpacity="0.3"
      />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg
      className="icon-button-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NewChatIcon() {
  return (
    <svg
      className="icon-button-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.8 5.4a1.8 1.8 0 0 1 1.8-1.8h6.8a1.8 1.8 0 0 1 1.8 1.8v4.2a1.8 1.8 0 0 1-1.8 1.8H7.2l-2.9 2.2v-2.2h-.1a1.4 1.4 0 0 1-1.4-1.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 5.3v3.2M6.4 6.9h3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg
      className="icon-button-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="8"
        cy="8"
        r="5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M8 4.9V8l2.2 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StatusConnectionIcon() {
  return (
    <svg
      className="status-connection-icon"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        className="status-connection-ring"
        cx="6"
        cy="6"
        r="4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle
        className="status-connection-core"
        cx="6"
        cy="6"
        r="2.1"
        fill="currentColor"
      />
      <path
        className="status-connection-mark"
        d="M6 3.4v3.2M6 8.2v.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
