(function () {
  'use strict';

  let display = '0';
  let stored = null;
  let pendingOp = null;
  let memory = 0;
  // Two distinct "fresh start" signals for the next digit press:
  // - replaceDisplay: the next digit should replace what's shown (after an
  //   operator, equals, or a unary function) instead of appending to it.
  // - resetChain: the next digit also means a brand new calculation, so
  //   drop the stored total/pending operator (only true after "=" or a
  //   unary function — NOT after choosing an operator, since that still
  //   needs stored/pendingOp around to finish the calculation).
  let replaceDisplay = false;
  let resetChain = false;

  const exprEl = document.getElementById('calcExpr');
  const resultEl = document.getElementById('calcResult');
  const memEl = document.getElementById('calcMemory');
  const grid = document.getElementById('calcGrid');

  function formatNum(n) {
    if (!isFinite(n)) return '오류';
    const rounded = Math.round(n * 1e10) / 1e10;
    return rounded.toString();
  }

  function opSymbol(op) {
    return { '+': '+', '-': '−', '*': '×', '/': '÷', '^': '^' }[op] || op;
  }

  function render() {
    resultEl.textContent = display;
    exprEl.textContent = stored !== null && pendingOp ? `${formatNum(stored)} ${opSymbol(pendingOp)}` : '';
    memEl.textContent = memory !== 0 ? `M = ${formatNum(memory)}` : '';
  }

  function inputDigit(d) {
    if (resetChain) {
      stored = null;
      pendingOp = null;
      resetChain = false;
    }
    if (replaceDisplay) {
      display = d === '.' ? '0.' : d;
      replaceDisplay = false;
      render();
      return;
    }
    if (display === '0' && d !== '.') display = d;
    else if (d === '.' && display.includes('.')) return;
    else display += d;
    render();
  }

  function applyOp(a, op, b) {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? NaN : a / b;
      case '^': return Math.pow(a, b);
      default: return b;
    }
  }

  function chooseOp(op) {
    const cur = parseFloat(display);
    if (pendingOp && !replaceDisplay) {
      stored = applyOp(stored, pendingOp, cur);
    } else {
      stored = cur;
    }
    pendingOp = op;
    replaceDisplay = true;
    display = formatNum(stored);
    render();
  }

  function equals() {
    if (pendingOp === null) return;
    const cur = parseFloat(display);
    stored = applyOp(stored, pendingOp, cur);
    display = formatNum(stored);
    pendingOp = null;
    replaceDisplay = true;
    resetChain = true;
    render();
  }

  function unary(fn) {
    const cur = parseFloat(display);
    display = formatNum(fn(cur));
    replaceDisplay = true;
    resetChain = true;
    render();
  }

  function backspace() {
    if (replaceDisplay) return;
    display = display.length > 1 ? display.slice(0, -1) : '0';
    render();
  }

  function clearAll() {
    display = '0';
    stored = null;
    pendingOp = null;
    replaceDisplay = false;
    resetChain = false;
    render();
  }

  const BUTTONS = [
    { label: 'MC', cls: 'fn', action: () => { memory = 0; render(); } },
    { label: 'MR', cls: 'fn', action: () => { display = formatNum(memory); replaceDisplay = true; resetChain = true; render(); } },
    { label: 'M+', cls: 'fn', action: () => { memory += parseFloat(display); render(); } },
    { label: 'M-', cls: 'fn', action: () => { memory -= parseFloat(display); render(); } },
    { label: '⌫', cls: 'fn', action: backspace },
    { label: '%', cls: 'fn', action: () => unary((v) => v / 100) },
    { label: '√', cls: 'fn', action: () => unary((v) => Math.sqrt(v)) },
    { label: 'x²', cls: 'fn', action: () => unary((v) => v * v) },
    { label: 'sin', cls: 'fn', action: () => unary((v) => Math.sin((v * Math.PI) / 180)) },
    { label: 'cos', cls: 'fn', action: () => unary((v) => Math.cos((v * Math.PI) / 180)) },
    { label: '7', cls: 'num', action: () => inputDigit('7') },
    { label: '8', cls: 'num', action: () => inputDigit('8') },
    { label: '9', cls: 'num', action: () => inputDigit('9') },
    { label: '÷', cls: 'op', action: () => chooseOp('/') },
    { label: 'tan', cls: 'fn', action: () => unary((v) => Math.tan((v * Math.PI) / 180)) },
    { label: '4', cls: 'num', action: () => inputDigit('4') },
    { label: '5', cls: 'num', action: () => inputDigit('5') },
    { label: '6', cls: 'num', action: () => inputDigit('6') },
    { label: '×', cls: 'op', action: () => chooseOp('*') },
    { label: 'log', cls: 'fn', action: () => unary((v) => Math.log10(v)) },
    { label: '1', cls: 'num', action: () => inputDigit('1') },
    { label: '2', cls: 'num', action: () => inputDigit('2') },
    { label: '3', cls: 'num', action: () => inputDigit('3') },
    { label: '−', cls: 'op', action: () => chooseOp('-') },
    { label: '±', cls: 'num', action: () => { display = formatNum(parseFloat(display) * -1); render(); } },
    { label: '0', cls: 'num', action: () => inputDigit('0') },
    { label: '.', cls: 'num', action: () => inputDigit('.') },
    { label: '+', cls: 'op', action: () => chooseOp('+') },
    { label: 'C', cls: 'clear', action: clearAll },
    { label: '=', cls: 'eq', action: equals },
  ];

  BUTTONS.forEach((b) => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'calc-btn ' + b.cls;
    btn.addEventListener('click', b.action);
    grid.appendChild(btn);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key >= '0' && e.key <= '9') inputDigit(e.key);
    else if (e.key === '.') inputDigit('.');
    else if (e.key === '+') chooseOp('+');
    else if (e.key === '-') chooseOp('-');
    else if (e.key === '*') chooseOp('*');
    else if (e.key === '/') { e.preventDefault(); chooseOp('/'); }
    else if (e.key === 'Enter' || e.key === '=') equals();
    else if (e.key === 'Backspace') backspace();
    else if (e.key === 'Escape') clearAll();
  });

  // Copies the current result as plain text so it can be pasted into the
  // note (or anywhere else) with a normal Ctrl+V.
  const copyBtn = document.getElementById('calcCopyBtn');
  copyBtn.addEventListener('click', () => {
    const ta = document.createElement('textarea');
    ta.value = display;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copyBtn.classList.add('copied');
    copyBtn.textContent = '✓';
    clearTimeout(copyBtn._resetTimer);
    copyBtn._resetTimer = setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.textContent = '📋';
    }, 1000);
  });

  // A number selected in a note can be sent here (via the 🧮→ button in the
  // editor toolbar) to continue calculating with it.
  if (window.api && window.api.onLoadValue) {
    window.api.onLoadValue((v) => {
      display = formatNum(v);
      stored = null;
      pendingOp = null;
      replaceDisplay = false;
      resetChain = false;
      render();
    });
  }

  render();
})();
