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
