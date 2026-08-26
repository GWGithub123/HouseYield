/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      spacing: {
        65: '16.25rem', // enables w-65, h-65, p-65, etc.
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-4px)' },
        },
        wave: {
          '0%, 100%': { transform: 'rotate(0deg)' },
          '50%': { transform: 'rotate(10deg)' },
        },
      },
      animation: {
        float: 'float 4s ease-in-out infinite',
        wave: 'wave 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
