/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './templates/**/*.ejs',
    './public/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        status: {
          offen: '#f59e0b',
          in_bearbeitung: '#3b82f6',
          wartend: '#8b5cf6',
          geschlossen: '#10b981',
        },
        priority: {
          niedrig: '#6b7280',
          mittel: '#3b82f6',
          hoch: '#f59e0b',
          kritisch: '#ef4444',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-in': 'slideIn 0.3s ease-out',
      },
      keyframes: {
        slideIn: {
          '0%': { transform: 'translateY(-10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        }
      }
    },
  },
  plugins: [],
}