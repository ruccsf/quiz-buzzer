// Socket.IO 客户端封装
const socket = io({
  transports: ['websocket'],  // 仅使用 WebSocket，禁用 HTTP long-polling
});

// Toast 通知 — 左下角显示，3.5秒后自动淡出并彻底移除
let toastTimer = null;

function showToast(msg, type = 'error') {
  // 清除旧 toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  clearTimeout(toastTimer);

  // 创建新 toast
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);

  // 强制回流后添加 show 类触发入场动画
  toast.offsetHeight;
  toast.classList.add('show');

  // 3 秒后开始淡出，再彻底移除 DOM
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    // 等待过渡动画结束再移除节点
    const removeTimer = setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 400);
    // 存到 toast 上方便清理
    toast._removeTimer = removeTimer;
  }, 3000);
}

// ======== 工具函数 ========
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// 复制文本到剪贴板
function copyText(text, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = '✅';
      setTimeout(() => btn.textContent = orig, 1500);
    }).catch(() => fallbackCopy(text, btn));
  } else {
    fallbackCopy(text, btn);
  }
}
function fallbackCopy(text, btn) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); btn.textContent = '✅'; setTimeout(() => btn.textContent = '📋', 1500); } catch(e) {}
  document.body.removeChild(ta);
}

// ======== 音效系统（Web Audio API 合成，零依赖） ========
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  }
  return audioCtx;
}
// 页面加载时立即创建 AudioContext（避免首次 playSound 时延迟）
getAudioCtx();
// 在任意用户交互时恢复（浏览器要求 AudioContext 必须在手势内激活）
function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}
document.addEventListener('click', resumeAudio);
document.addEventListener('touchstart', resumeAudio);
document.addEventListener('keydown', resumeAudio);

function playSound(type) {
  const ctx = getAudioCtx();
  if (!ctx) return;

  function doPlay() {
    try {
      switch (type) {
        case 'buzz':
          playTone(ctx, 880, 0.08, 'triangle', 0.25);
          setTimeout(() => playTone(ctx, 1175, 0.12, 'triangle', 0.3), 60);
          break;
        case 'correct':
          playTone(ctx, 523, 0.1, 'triangle', 0.2);
          setTimeout(() => playTone(ctx, 659, 0.1, 'triangle', 0.2), 80);
          setTimeout(() => playTone(ctx, 784, 0.1, 'triangle', 0.2), 160);
          setTimeout(() => playTone(ctx, 1047, 0.2, 'triangle', 0.25), 240);
          break;
        case 'wrong':
          playTone(ctx, 440, 0.15, 'sawtooth', 0.15);
          setTimeout(() => playTone(ctx, 330, 0.2, 'sawtooth', 0.15), 120);
          break;
        case 'tick':
          playTone(ctx, 800, 0.03, 'square', 0.06);
          break;
        case 'tickWarn':
          playTone(ctx, 1000, 0.04, 'square', 0.08);
          break;
        case 'timesUp':
          playTone(ctx, 330, 0.2, 'square', 0.12);
          setTimeout(() => playTone(ctx, 220, 0.3, 'square', 0.12), 180);
          break;
        case 'join':
          playTone(ctx, 523, 0.15, 'triangle', 0.25);
          setTimeout(() => playTone(ctx, 659, 0.15, 'triangle', 0.25), 100);
          setTimeout(() => playTone(ctx, 784, 0.2, 'triangle', 0.3), 200);
          break;
        case 'publish':
          playTone(ctx, 440, 0.25, 'triangle', 0.8);
          setTimeout(() => playTone(ctx, 554, 0.25, 'triangle', 0.8), 200);
          setTimeout(() => playTone(ctx, 659, 0.35, 'triangle', 0.8), 400);
          break;
      }
    } catch(e) {}
  }

  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  doPlay();
}

function playTone(ctx, freq, duration, type, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

// 从剪贴板粘贴房间号到输入框
function pasteText(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(text => {
      // 清理：去空格、转大写、只保留字母数字
      const cleaned = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      input.value = cleaned;
      btn.textContent = '✅';
      setTimeout(() => btn.textContent = '📥', 1500);
      // 触发表单输入事件（房间号自动大写逻辑依赖它）
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }).catch(() => {
      showToast('无法读取剪贴板，请检查权限设置');
    });
  } else {
    showToast('浏览器不支持剪贴板读取，请手动输入');
  }
}
