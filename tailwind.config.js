/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#f8f9fc',
        foreground: '#1e2132',

        neutral: {
          50: '#f8f9fc',
          100: '#f1f3f8',
          200: '#e2e5ee',
          300: '#cdd1de',
          400: '#9ba2b5',
          500: '#6e7590',
          600: '#515873',
          700: '#3f4560',
          800: '#2d3148',
          900: '#1e2132',
          950: '#12141f',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'SF Mono',
          'Menlo',
          'Monaco',
          'Inconsolata',
          'monospace',
        ],
      },
      fontSize: {
        'page-title': ['20px', { lineHeight: '28px', fontWeight: '600' }],
        'section-title': ['16px', { lineHeight: '24px', fontWeight: '500' }],
        'card-title': ['13px', { lineHeight: '18px', fontWeight: '500' }],
        'kpi': ['20px', { lineHeight: '28px', fontWeight: '600' }],
        'body': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'label': ['12px', { lineHeight: '16px', fontWeight: '400' }],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
      },
      boxShadow: {
        'subtle': '0 1px 2px 0 rgb(0 0 0 / 0.03)',
        'card': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      },
    },
  },
  plugins: [],
}
