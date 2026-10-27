/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,vue}'],
  safelist: [
    'px-button-primary',
    'px-button-secondary',
    'px-button-danger',
    'px-button-ghost',
    'px-button-sm',
    'px-button-md',
    'px-button-lg',
    'px-icon-button-quiet',
    'px-icon-button-primary',
    'px-icon-button-danger',
    'px-icon-button-sm',
    'px-icon-button-md',
    'px-icon-button-lg',
    'px-alert-error',
    'px-alert-warning',
    'px-alert-info',
    'px-alert-success',
    'px-select-sm',
    'px-select-md',
    'px-select-lg',
    'px-select-default',
    'px-select-pill',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--theme-fontSans)"],
        serif: ["var(--theme-fontSerif)"],
        mono: ["var(--theme-fontMono)"],
      },
      boxShadow: {
        panel: '0 1px 0 rgba(28, 25, 23, 0.12)',
      },
    },
  },
  plugins: [],
}
