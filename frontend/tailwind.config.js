/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // Brand accents used across the module UIs.
      colors: {
        brand: {
          ink: '#0f172a',
        },
      },
    },
  },
  plugins: [],
};
