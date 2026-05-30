// Socket.IO 客户端封装
const socket = io();

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
