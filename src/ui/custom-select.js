// 自定义下拉选择器。
//
// 原生 <select> 的弹出层由系统绘制，在 WebView 里既不接受本项目的皮肤，也无法
// 跟随「减少透明度 / 提高对比度」这些设置。所以这里把它留在 DOM 里当作真正的
// 状态载体——值、change 事件、表单语义都还在它身上——只是移出视线，另外画一套
// 按钮与选项列表覆盖上去。
//
// 这样做的代价是无障碍：一个被藏起来的 <select> 对读屏软件等于不存在。因此下面
// 的按钮自己带 role、aria-expanded 与 aria-activedescendant，并且实现了键盘操作
// （上下键移动、Enter/空格确认、Esc 关闭、Home/End 跳到首尾）。
//
// 选项文本每次打开时重新从 <select> 读取，而不是初始化时抄一份。语言切换会把
// <option> 的文字整批换掉，抄一份就意味着列表永远停在旧语言上。

/** 当前展开的那一个，全局至多一个。 */
let openMenu = null;

/** 关掉当前展开的下拉，若本来就没有则什么也不做。 */
function closeOpen() {
  if (!openMenu) return;
  const { wrap, button, list } = openMenu;
  list.hidden = true;
  button.classList.remove('open');
  button.setAttribute('aria-expanded', 'false');
  button.removeAttribute('aria-activedescendant');
  wrap.classList.remove('is-open');
  openMenu = null;
}

/**
 * 收起下拉的三种途径：点别处、按 Esc、窗口尺寸变化。
 *
 * 只挂一次。上一版把这行写在初始化函数里，而初始化会被重复调用（切换皮肤、
 * 重建设置页都会再调一次），于是每调一次就多一个监听器，同一次点击被处理很多遍。
 */
let globalBound = false;

function bindGlobalDismiss() {
  if (globalBound) return;
  globalBound = true;
  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.wrap.contains(e.target)) closeOpen();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) {
      const btn = openMenu.button;
      closeOpen();
      btn.focus();
    }
  });
  window.addEventListener('resize', closeOpen, { passive: true });
}

/** 一个唯一的 id 前缀，供 aria-activedescendant 指向具体选项。 */
let seq = 0;

/**
 * 把每个 .set-select-wrap 里的原生 <select> 换成一套可见的按钮 + 列表。
 *
 * 可以重复调用：已经处理过的容器会被跳过，不会叠加第二套控件。
 */
export function initCustomSelects() {
  bindGlobalDismiss();

  document.querySelectorAll('.set-select-wrap').forEach((wrap) => {
    const select = wrap.querySelector('.set-select');
    if (!select || wrap.querySelector('.set-select-btn')) return;

    const id = `sel${++seq}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'set-select-btn';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    const list = document.createElement('div');
    list.className = 'set-select-dropdown';
    list.setAttribute('role', 'listbox');
    list.id = `${id}-list`;
    list.hidden = true;
    button.setAttribute('aria-controls', list.id);

    /** 当前高亮到第几项——键盘移动的游标，未必等于已选中的那项。 */
    let cursor = -1;

    const options = () => [...list.querySelectorAll('.set-option')];

    /** 按 <select> 现在的内容重画列表。语言一换，文字就跟着换。 */
    const rebuild = () => {
      list.replaceChildren();
      [...select.options].forEach((opt, i) => {
        const row = document.createElement('div');
        row.className = 'set-option';
        row.id = `${id}-opt${i}`;
        row.setAttribute('role', 'option');
        row.textContent = opt.textContent;
        row.dataset.value = opt.value;
        const chosen = opt.value === select.value;
        row.classList.toggle('selected', chosen);
        row.setAttribute('aria-selected', chosen ? 'true' : 'false');
        if (chosen) cursor = i;
        row.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          commit(i);
        });
        list.appendChild(row);
      });
      button.textContent = select.selectedOptions[0]?.textContent ?? '';
    };

    /** 把高亮移到第 i 项，并让读屏软件知道现在停在哪。 */
    const highlight = (i) => {
      const rows = options();
      if (!rows.length) return;
      cursor = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((r, n) => r.classList.toggle('is-active', n === cursor));
      button.setAttribute('aria-activedescendant', rows[cursor].id);
      // 列表可能比可视区长；把高亮项带进视野。并非所有环境都实现这个方法。
      rows[cursor].scrollIntoView?.({ block: 'nearest' });
    };

    /**
     * 选定第 i 项。
     *
     * 值写回真正的 <select>，change 事件也从它身上派发——页面其余部分监听的是
     * 原生控件，不该知道上面还盖着一层。
     */
    const commit = (i) => {
      const rows = options();
      const row = rows[i];
      if (!row) return;
      if (select.value !== row.dataset.value) {
        select.value = row.dataset.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      rebuild();
      closeOpen();
      button.focus();
    };

    const open = () => {
      closeOpen();
      rebuild();
      list.hidden = false;
      button.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
      wrap.classList.add('is-open');
      openMenu = { wrap, button, list };
      highlight(cursor < 0 ? 0 : cursor);
    };

    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openMenu && openMenu.button === button) closeOpen();
      else open();
    });

    button.addEventListener('keydown', (e) => {
      const isOpen = !!openMenu && openMenu.button === button;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          e.preventDefault();
          if (!isOpen) { open(); return; }
          highlight(cursor + (e.key === 'ArrowDown' ? 1 : -1));
          return;
        case 'Home':
        case 'End':
          if (!isOpen) return;
          e.preventDefault();
          highlight(e.key === 'Home' ? 0 : options().length - 1);
          return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (isOpen) commit(cursor);
          else open();
          return;
        default:
      }
    });

    rebuild();
    wrap.append(button, list);
  });
}

/**
 * 让按钮上的文字与 <select> 的当前值重新对齐。
 *
 * 用在值不是由用户点出来、而是程序改的时候：读取已保存的设置、切换语言之后
 * 重新翻译过的选项文字，等等。
 */
export function syncCustomSelects() {
  document.querySelectorAll('.set-select-wrap').forEach((wrap) => {
    const select = wrap.querySelector('.set-select');
    const button = wrap.querySelector('.set-select-btn');
    if (!select || !button) return;
    button.textContent = select.selectedOptions[0]?.textContent ?? '';
    wrap.querySelectorAll('.set-option').forEach((row) => {
      const chosen = row.dataset.value === select.value;
      row.classList.toggle('selected', chosen);
      row.setAttribute('aria-selected', chosen ? 'true' : 'false');
    });
  });
}
