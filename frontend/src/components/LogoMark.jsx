import { useId } from 'react';

export default function LogoMark({ size = 32 }) {
  const gradientId = useId().replaceAll(':', '');
  const backgroundId = `mailexpert_bg_${gradientId}`;
  const accentId = `mailexpert_accent_${gradientId}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={backgroundId} x1="3" y1="2" x2="29" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1ea7ff" />
          <stop offset="0.48" stopColor="#1261e8" />
          <stop offset="1" stopColor="#071b63" />
        </linearGradient>
        <linearGradient id={accentId} x1="13" y1="17" x2="19" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff7158" />
          <stop offset="1" stopColor="#e4002b" />
        </linearGradient>
      </defs>

      <rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${backgroundId})`} />
      <path d="M2.2 8.3C8.4 3.4 17.1 1.4 28.7 2.8C20.5 4.6 10.6 9 2 16.8V9.5C2 9.1 2.1 8.7 2.2 8.3Z" fill="#ffffff" opacity="0.09" />

      <rect x="5.5" y="10.2" width="21" height="14.4" rx="2.7" fill="#ffffff" />
      <path d="M5.8 11.1L16 19.3L26.2 11.1" fill="none" stroke="#cbdcf7" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="M5.8 23.8L13.1 18.1M26.2 23.8L18.9 18.1" fill="none" stroke="#dce8fa" strokeWidth="1.1" />
      <path d="M13.1 17.1L16 19.3L18.9 17.1L16 21.1L13.1 17.1Z" fill={`url(#${accentId})`} />
    </svg>
  );
}
