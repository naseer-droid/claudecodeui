type KimiLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is Kimi Code. */
const KimiLogo = ({ className = 'w-5 h-5' }: KimiLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Kimi Code"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="fill-foreground" />
    <path
      d="M9 7v10M9 12l5.5-5M10.8 11l4.2 6"
      className="stroke-background"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default KimiLogo;
