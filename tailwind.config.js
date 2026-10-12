module.exports = {
  content: ['./app.js', './index.html'],
  theme: { extend: {
    fontFamily: { sans: ['Outfit', 'sans-serif'] },
    colors: { magical: { pink: '#FF007A', cyan: '#00F0FF', purple: '#7000FF', gold: '#FFD700', bg: '#050212' } },
  } },
  // Classes construites dynamiquement dans app.js (codeField) :
  safelist: [{ pattern: /(text|bg|border|ring)-magical-(cyan|purple)(\/(15|25|30|40))?/, variants: ['hover', 'focus'] }],
};
