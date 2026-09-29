import { useId } from 'react';

type AntigravityLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is Google Antigravity. */
const AntigravityLogo = ({ className = 'w-5 h-5' }: AntigravityLogoProps) => {
  // Several logos can render at once (sidebar, picker), so the gradient id must be unique.
  const gradientId = `antigravity-logo-${useId().replace(/:/g, '')}`;

  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Antigravity"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="3" y1="20" x2="21" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4285F4" />
          <stop offset="0.35" stopColor="#34A853" />
          <stop offset="0.7" stopColor="#FBBC05" />
          <stop offset="1" stopColor="#EA4335" />
        </linearGradient>
      </defs>
      {/* An arch lifting off the ground: the "A" of Antigravity. */}
      <path
        d="M4 20.5C5.5 20.5 6.4 19.2 7.4 16.8L10.1 9.6C10.9 7.5 11.3 5.5 12 5.5C12.7 5.5 13.1 7.5 13.9 9.6L16.6 16.8C17.6 19.2 18.5 20.5 20 20.5"
        stroke={`url(#${gradientId})`}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default AntigravityLogo;
