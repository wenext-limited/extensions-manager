"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
// @ts-ignore
const pkgJson = require('../../../package.json');
/** 长时间无响应时自动解除全屏遮挡，避免界面永久锁死 */
const OPERATION_OVERLAY_TIMEOUT_MS = 10 * 60 * 1000;
/** 远程注册表进度条：超时后请求主进程终止 git，避免无限等待 */
const REGISTRY_SYNC_UI_TIMEOUT_MS = 90 * 1000;
/** 可更新时的推荐目标：远程较新的 semver tag（由主进程写入 remoteLatestVersion） */
function getUpgradeTarget(ext) {
    if (ext.status !== 'need_update')
        return null;
    return ext.remoteLatestVersion || ext.requiredVersion || null;
}
function displayVersionLabel(v) {
    const t = v.trim();
    if (!t)
        return '';
    return t.startsWith('v') ? t : `v${t}`;
}
/** 图标方格内展示：取扩展名的首字母（ASCII 大写；中文取首字） */
function extensionNameInitial(name) {
    const t = name.trim();
    if (!t)
        return '?';
    const ascii = t.match(/[a-zA-Z]/);
    if (ascii)
        return ascii[0].toUpperCase();
    const cjk = t.match(/[\u4e00-\u9fff]/);
    if (cjk)
        return cjk[0];
    return t[0].toUpperCase();
}
module.exports = Editor.Panel.define({
    listeners: {
        show() {
            if (this._isFirstLoad === false && this.log) {
                this.log('面板已显示，正在同步远程注册表…');
                void this.loadSelfInfo();
                void this.refreshList();
                this.runRegistryRefreshWithProgress();
            }
        },
        hide() { },
    },
    template: (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        extList: '#ext-list',
        searchPlugins: '#search-plugins',
        btnSync: '#btn-sync',
        btnRefresh: '#btn-refresh',
        logOutput: '#log-output',
        logPanelWrap: '#log-panel-wrap',
        btnClearLog: '#btn-clear-log',
        btnCopyLog: '#btn-copy-log',
        ctxMenu: '#ctx-menu',
        ctxOpenDir: '#ctx-open-dir',
        selfInfo: '#self-info',
        sidebarVersion: '#sidebar-version',
        navScrollLogs: '#nav-scroll-logs',
        navHelp: '#nav-help',
        operationOverlay: '#operation-overlay',
        operationOverlayTitle: '#operation-overlay-title',
        operationOverlayHint: '#operation-overlay-hint',
        registrySyncBar: '#registry-sync-bar',
        registrySyncText: '#registry-sync-text',
        registrySyncCancel: '#registry-sync-cancel',
    },
    methods: {
        /** 嵌套安全：多项异步重叠时仅在最后一项结束时隐藏遮挡 */
        beginBlockingOperation(opts) {
            var _a, _b;
            const overlay = this.$.operationOverlay;
            const titleEl = this.$.operationOverlayTitle;
            const hintEl = this.$.operationOverlayHint;
            if (titleEl) {
                titleEl.textContent = (_a = opts === null || opts === void 0 ? void 0 : opts.title) !== null && _a !== void 0 ? _a : '正在处理...';
            }
            if (hintEl) {
                hintEl.textContent = (_b = opts === null || opts === void 0 ? void 0 : opts.hint) !== null && _b !== void 0 ? _b : '请稍候，操作正在进行中...';
            }
            this._blockingOpCount = (this._blockingOpCount || 0) + 1;
            if (this._blockingOpCount === 1 && overlay) {
                overlay.hidden = false;
                overlay.setAttribute('aria-hidden', 'false');
            }
            this._armOperationTimeout();
        },
        endBlockingOperation() {
            this._blockingOpCount = Math.max(0, (this._blockingOpCount || 0) - 1);
            if (this._blockingOpCount === 0) {
                this._clearOperationTimeout();
                const overlay = this.$.operationOverlay;
                if (overlay) {
                    overlay.hidden = true;
                    overlay.setAttribute('aria-hidden', 'true');
                }
            }
        },
        _armOperationTimeout() {
            if (this._operationTimeoutId != null) {
                clearTimeout(this._operationTimeoutId);
            }
            this._operationTimeoutId = setTimeout(() => {
                this._operationTimeoutId = null;
                if ((this._blockingOpCount || 0) <= 0)
                    return;
                this._blockingOpCount = 0;
                const overlay = this.$.operationOverlay;
                if (overlay) {
                    overlay.hidden = true;
                    overlay.setAttribute('aria-hidden', 'true');
                }
                this.setButtonsEnabled(true);
                try {
                    this._operatingItems.clear();
                }
                catch (_a) {
                    /* ignore */
                }
                this.log('⚠ 操作等待超时，已解除界面锁定（若命令仍在后台运行，请稍后手动刷新列表）');
                this.refreshList();
            }, OPERATION_OVERLAY_TIMEOUT_MS);
        },
        _clearOperationTimeout() {
            if (this._operationTimeoutId != null) {
                clearTimeout(this._operationTimeoutId);
                this._operationTimeoutId = null;
            }
        },
        /** 加载并渲染插件管理器自身的版本状态 */
        appendSystemStatus(container, ok, warn, text, title) {
            const row = document.createElement('div');
            row.className = 'system-status';
            const dot = document.createElement('span');
            dot.className = 'system-status-dot' + (warn ? ' system-status-dot--warn' : '');
            if (!ok && !warn)
                dot.className = 'system-status-dot system-status-dot--warn';
            row.appendChild(dot);
            const t = document.createElement('span');
            t.textContent = text;
            if (title)
                t.title = title;
            row.appendChild(t);
            container.appendChild(row);
        },
        async loadSelfInfo() {
            const el = this.$.selfInfo;
            if (!el)
                return;
            try {
                const info = await Editor.Message.request('extensions-manager', 'get-self-info');
                el.innerHTML = '';
                el.className = 'core-version-row';
                const label = document.createElement('span');
                label.className = 'core-version-label';
                label.textContent = '核心系统版本:';
                el.appendChild(label);
                const localVer = info.installedVersion || String(pkgJson.version || '?');
                const pill = document.createElement('span');
                pill.className = 'version-pill';
                pill.textContent = displayVersionLabel(localVer);
                el.appendChild(pill);
                if (info.status === 'need_update') {
                    el.classList.add('has-update');
                    const vSelect = document.createElement('select');
                    vSelect.className = 'version-select';
                    const pref = getUpgradeTarget(info) || '';
                    const opt = document.createElement('option');
                    opt.value = pref;
                    opt.textContent = pref;
                    vSelect.appendChild(opt);
                    el.appendChild(vSelect);
                    const updateBtn = document.createElement('button');
                    updateBtn.className = 'btn btn-primary';
                    updateBtn.textContent = '更新';
                    updateBtn.addEventListener('click', () => this.doInstall(info.name, vSelect.value.trim()));
                    el.appendChild(updateBtn);
                    this.attachLazyVersionLoader(vSelect, info.name, pref || info.installedVersion);
                    this.appendSystemStatus(el, false, true, '插件可更新', pref || undefined);
                }
                else {
                    const badge = document.createElement('span');
                    badge.className = 'status-badge status-synced';
                    badge.textContent = '已是最新';
                    el.appendChild(badge);
                    this.appendSystemStatus(el, true, false, '系统运行正常');
                }
                el.style.display = 'flex';
            }
            catch (err) {
                const msg = String((err === null || err === void 0 ? void 0 : err.message) || err || '');
                console.warn('[extensions-manager] loadSelfInfo 失败:', msg);
                el.innerHTML = '';
                el.className = 'core-version-row self-info-fallback';
                const label = document.createElement('span');
                label.className = 'core-version-label';
                label.textContent = '核心系统版本:';
                el.appendChild(label);
                const pill = document.createElement('span');
                pill.className = 'version-pill';
                pill.textContent = displayVersionLabel(String(pkgJson.version || '?'));
                el.appendChild(pill);
                const hint = document.createElement('span');
                hint.className = 'status-badge status-not-installed';
                const short = msg.includes('Message does not exist') || msg.includes('Method does not exist')
                    ? '无法检查远程版本：请在扩展目录执行 npm run build，重新打开 Cocos Creator 或完全重载本扩展'
                    : (msg.length > 120 ? `${msg.slice(0, 117)}…` : msg);
                hint.textContent = short || '无法检查远程版本';
                hint.title = msg;
                el.appendChild(hint);
                this.appendSystemStatus(el, false, true, '版本检查异常', msg);
                el.style.display = 'flex';
                try {
                    this.log(`⚠ 插件自身版本信息：${hint.textContent}`);
                }
                catch ( /* ignore */_a) { /* ignore */ }
            }
        },
        async tryRefreshRegistry() {
            try {
                const result = await Editor.Message.request('extensions-manager', 'refresh-registry');
                if (result === null || result === void 0 ? void 0 : result.success) {
                    this.log(`✓ ${result.output}`);
                }
                else if (result === null || result === void 0 ? void 0 : result.output) {
                    this.log(`⚠ ${result.output}`);
                }
                return true;
            }
            catch (err) {
                const message = String((err === null || err === void 0 ? void 0 : err.message) || err || '');
                if (message.includes('Message does not exist')) {
                    this.log('⚠ 当前扩展版本不支持远程刷新，已使用本地注册表');
                    return false;
                }
                this.log(`⚠ 更新注册表异常: ${message}`);
                return false;
            }
        },
        _showRegistrySyncBar() {
            const bar = this.$.registrySyncBar;
            if (bar)
                bar.hidden = false;
            const t = this.$.registrySyncText;
            if (t)
                t.textContent = '正在从远程更新扩展注册表…';
        },
        _hideRegistrySyncBar() {
            const bar = this.$.registrySyncBar;
            if (bar)
                bar.hidden = true;
        },
        /**
         * 顶部进度条 + 可取消 + 界面 90s 超时（会 kill git）；正常结束后再刷新列表。
         */
        runRegistryRefreshWithProgress(opts) {
            this._registrySyncGen = (this._registrySyncGen || 0) + 1;
            const gen = this._registrySyncGen;
            this._showRegistrySyncBar();
            const timeoutId = setTimeout(() => {
                if (this._registrySyncGen !== gen)
                    return;
                this._registrySyncGen++;
                void Editor.Message.request('extensions-manager', 'cancel-fetch-registry')
                    .then((r) => {
                    if (r === null || r === void 0 ? void 0 : r.success) {
                        this.log('⚠ 远程注册表更新已超过等待时间，已中断拉取');
                    }
                    else {
                        this.log('⚠ 远程注册表更新等待超时，界面不再阻塞（若 clone 已结束可忽略）');
                    }
                })
                    .catch(() => this.log('⚠ 远程注册表更新等待超时'));
                this._hideRegistrySyncBar();
                this.refreshList();
            }, REGISTRY_SYNC_UI_TIMEOUT_MS);
            void (async () => {
                try {
                    await this.tryRefreshRegistry();
                }
                finally {
                    clearTimeout(timeoutId);
                    if (this._registrySyncGen === gen) {
                        this._hideRegistrySyncBar();
                        this.refreshList();
                        if (opts === null || opts === void 0 ? void 0 : opts.reloadSelf)
                            void this.loadSelfInfo();
                    }
                }
            })();
        },
        onRegistrySyncCancel() {
            this._registrySyncGen = (this._registrySyncGen || 0) + 1;
            void Editor.Message.request('extensions-manager', 'cancel-fetch-registry')
                .then((r) => {
                if (r === null || r === void 0 ? void 0 : r.success)
                    this.log('已取消远程注册表更新');
                else
                    this.log('当前没有进行中的注册表拉取');
            })
                .catch(() => this.log('取消注册表更新失败'));
            this._hideRegistrySyncBar();
            this.refreshList();
        },
        log(message) {
            const el = this.$.logOutput;
            if (!el)
                return;
            const ts = new Date().toLocaleTimeString();
            const line = document.createElement('div');
            line.className = 'log-line';
            if (message.includes('✓') || message.includes('成功'))
                line.classList.add('log-line--success');
            else if (message.includes('⚠'))
                line.classList.add('log-line--warn');
            else if (message.includes('✗'))
                line.classList.add('log-line--error');
            const tsSpan = document.createElement('span');
            tsSpan.className = 'log-ts';
            tsSpan.textContent = `[${ts}] `;
            line.appendChild(tsSpan);
            const body = document.createElement('span');
            body.className = 'log-body';
            body.textContent = message;
            line.appendChild(body);
            el.appendChild(line);
            el.scrollTop = el.scrollHeight;
        },
        async copyLogs() {
            const el = this.$.logOutput;
            if (!el)
                return;
            const text = el.innerText || '';
            if (!text.trim()) {
                this.log('⚠ 当前没有可复制的日志');
                return;
            }
            try {
                await navigator.clipboard.writeText(text);
                this.log('✓ 日志已复制到剪贴板');
            }
            catch (_a) {
                // 某些环境不支持 clipboard API，回退到 execCommand
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', 'true');
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                let ok = false;
                try {
                    ok = document.execCommand('copy');
                }
                catch (_b) {
                    ok = false;
                }
                document.body.removeChild(ta);
                if (ok)
                    this.log('✓ 日志已复制到剪贴板');
                else
                    this.log('⚠ 复制失败，请手动选中日志复制');
            }
        },
        isLogSectionVisible() {
            try {
                const v = localStorage.getItem('extensions-manager.logSectionVisible');
                if (v === null)
                    return false;
                return v === '1' || v === 'true';
            }
            catch (_a) {
                return false;
            }
        },
        applyLogSectionVisibility(visible) {
            const wrap = this.$.logPanelWrap;
            const btn = this.$.navScrollLogs;
            if (!wrap)
                return;
            wrap.hidden = !visible;
            if (btn) {
                btn.textContent = visible ? '隐藏日志' : '显示日志';
                btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
                btn.title = visible ? '隐藏操作日志区域' : '显示操作日志区域';
            }
            try {
                localStorage.setItem('extensions-manager.logSectionVisible', visible ? '1' : '0');
            }
            catch (_a) {
                /* ignore quota / private mode */
            }
        },
        toggleLogSection() {
            const wrap = this.$.logPanelWrap;
            if (!wrap)
                return;
            const hidden = wrap.hidden;
            if (hidden) {
                this.applyLogSectionVisibility(true);
                wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            else {
                this.applyLogSectionVisibility(false);
            }
        },
        /** 按搜索框过滤已渲染的扩展卡片 */
        applySearchFilter() {
            const input = this.$.searchPlugins;
            const listEl = this.$.extList;
            if (!input || !listEl)
                return;
            const q = input.value.trim().toLowerCase();
            listEl.querySelectorAll('.ext-item').forEach((node) => {
                const item = node;
                const name = (item.dataset.extName || '').toLowerCase();
                const desc = (item.dataset.extDesc || '').toLowerCase();
                const match = !q || name.includes(q) || desc.includes(q);
                item.dataset.filterHidden = match ? '' : '1';
            });
        },
        /** 防抖刷新（300ms），首次加载立即执行 */
        refreshList() {
            if (this._refreshTimer) {
                clearTimeout(this._refreshTimer);
            }
            if (this._isFirstLoad) {
                this._isFirstLoad = false;
                this._doRefreshList();
            }
            else {
                this._refreshTimer = setTimeout(() => {
                    this._doRefreshList();
                }, 300);
            }
        },
        /** 实际刷新逻辑：无闪烁 DOM 更新 */
        async _doRefreshList() {
            const listEl = this.$.extList;
            // 首次加载时才显示 "加载中..."
            const isEmptyList = listEl.children.length === 0 ||
                (listEl.children.length === 1 && listEl.children[0].classList.contains('loading'));
            if (isEmptyList) {
                listEl.innerHTML = '<div class="loading">加载中...</div>';
            }
            try {
                const extensions = await Editor.Message.request('extensions-manager', 'list-all');
                const selfName = pkgJson.name;
                const listExtensions = (extensions || []).filter((e) => e.name !== selfName);
                if (!listExtensions.length) {
                    listEl.innerHTML = '<div class="loading">无扩展数据</div>';
                    return;
                }
                // 用 DocumentFragment 构建新列表，然后一次性替换
                const fragment = document.createDocumentFragment();
                for (const ext of listExtensions) {
                    fragment.appendChild(this.createExtItem(ext));
                }
                // 一次性替换所有子节点（无闪烁）
                listEl.innerHTML = '';
                listEl.appendChild(fragment);
                this.applySearchFilter();
            }
            catch (err) {
                listEl.innerHTML = `<div class="loading">加载失败: ${err.message || err}</div>`;
            }
        },
        createExtItem(ext) {
            const item = document.createElement('div');
            item.className = 'ext-item';
            item.dataset.extName = ext.name;
            item.dataset.extDesc = ext.description || '';
            // 若当前正在操作，加上 loading 样式
            if (this._operatingItems && this._operatingItems.has(ext.name)) {
                item.classList.add('item-loading');
            }
            const main = document.createElement('div');
            main.className = 'ext-card-main';
            const icon = document.createElement('div');
            icon.className = 'ext-card-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = extensionNameInitial(ext.name);
            main.appendChild(icon);
            const info = document.createElement('div');
            info.className = 'ext-card-info';
            const headerRow = document.createElement('div');
            headerRow.className = 'ext-card-header-row';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'ext-name';
            nameSpan.textContent = ext.name;
            headerRow.appendChild(nameSpan);
            const badge = document.createElement('span');
            badge.className = 'status-badge';
            switch (ext.status) {
                case 'synced':
                    badge.className += ' status-synced';
                    badge.textContent = '已是最新';
                    break;
                case 'need_update':
                    badge.className += ' status-need-update';
                    badge.textContent = '可更新';
                    break;
                case 'not_installed':
                    badge.className += ' status-not-installed';
                    badge.textContent = '未安装';
                    break;
                case 'not_in_manifest':
                    badge.className += ' status-not-installed';
                    badge.textContent = '不在清单中';
                    break;
            }
            headerRow.appendChild(badge);
            info.appendChild(headerRow);
            const desc = document.createElement('div');
            desc.className = 'ext-desc';
            desc.textContent = ext.description || '—';
            info.appendChild(desc);
            main.appendChild(info);
            item.appendChild(main);
            const footer = document.createElement('div');
            footer.className = 'ext-card-footer';
            const versionBlock = document.createElement('div');
            versionBlock.className = 'ext-version-block';
            const vLabel = document.createElement('span');
            vLabel.className = 'ext-version-label';
            vLabel.textContent = '版本详情';
            versionBlock.appendChild(vLabel);
            const line = document.createElement('div');
            line.className = 'ext-version-line';
            const upgradeTgt = getUpgradeTarget(ext);
            const reqNorm = upgradeTgt
                ? displayVersionLabel(upgradeTgt)
                : ext.requiredVersion
                    ? displayVersionLabel(ext.requiredVersion)
                    : '';
            if (ext.status === 'need_update' && ext.installedVersion && upgradeTgt) {
                const cur = document.createElement('span');
                cur.className = 'ext-version-current';
                cur.textContent = `当前: v${ext.installedVersion}`;
                const targetPill = document.createElement('span');
                targetPill.className = 'ext-version-target-pill';
                const arrow = document.createElement('span');
                arrow.className = 'ext-version-target-arrow';
                arrow.setAttribute('aria-hidden', 'true');
                arrow.textContent = '→';
                const tgtLabel = document.createElement('span');
                tgtLabel.className = 'ext-version-target-label';
                tgtLabel.textContent = '目标:';
                const tgtVer = document.createElement('span');
                tgtVer.className = 'ext-version-target-ver';
                tgtVer.textContent = reqNorm;
                targetPill.appendChild(arrow);
                targetPill.appendChild(tgtLabel);
                targetPill.appendChild(tgtVer);
                line.appendChild(cur);
                line.appendChild(targetPill);
            }
            else {
                const single = document.createElement('span');
                single.className = 'ext-version-single';
                if (ext.installedVersion) {
                    single.textContent = `当前: v${ext.installedVersion}`;
                }
                else if (ext.requiredVersion) {
                    single.textContent = `目标: ${reqNorm}`;
                }
                else {
                    single.textContent = '—';
                }
                line.appendChild(single);
            }
            versionBlock.appendChild(line);
            footer.appendChild(versionBlock);
            const actions = document.createElement('div');
            actions.className = 'ext-actions';
            if (ext.status === 'not_installed' || ext.status === 'need_update') {
                const vSelect = document.createElement('select');
                vSelect.className = 'version-select';
                const prefVer = getUpgradeTarget(ext) || ext.requiredVersion || '';
                const defaultOpt = document.createElement('option');
                defaultOpt.value = prefVer;
                defaultOpt.textContent = prefVer || '选择版本';
                vSelect.appendChild(defaultOpt);
                actions.appendChild(vSelect);
                const actionBtn = document.createElement('button');
                actionBtn.className = ext.status === 'need_update' ? 'btn btn-primary' : 'btn btn-install';
                actionBtn.textContent = ext.status === 'need_update' ? '更新' : '安装';
                actionBtn.disabled = false;
                actionBtn.addEventListener('click', () => {
                    const ver = vSelect.value.trim();
                    this.doInstall(ext.name, ver);
                });
                actions.appendChild(actionBtn);
                this.attachLazyVersionLoader(vSelect, ext.name, prefVer || ext.requiredVersion);
            }
            if (ext.status === 'need_update' || ext.status === 'synced' || ext.status === 'not_in_manifest') {
                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn btn-danger';
                removeBtn.textContent = '卸载';
                removeBtn.addEventListener('click', () => {
                    this.doUninstall(ext.name);
                });
                actions.appendChild(removeBtn);
            }
            footer.appendChild(actions);
            item.appendChild(footer);
            // 右键菜单绑定
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const menu = this._ctxMenu;
                if (!menu)
                    return;
                this._ctxTarget = ext.name;
                const openDirItem = menu.querySelector('#ctx-open-dir');
                if (ext.installedVersion) {
                    openDirItem.classList.remove('ctx-disabled');
                }
                else {
                    openDirItem.classList.add('ctx-disabled');
                }
                const mw = 150, mh = 38;
                let x = e.clientX, y = e.clientY;
                if (x + mw > window.innerWidth)
                    x = window.innerWidth - mw - 4;
                if (y + mh > window.innerHeight)
                    y = window.innerHeight - mh - 4;
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                menu.style.display = 'block';
            });
            return item;
        },
        /**
         * 创建下拉后立即请求远程 tags；同时保留交互触发兜底，避免首轮请求失败后无法再次加载。
         * 完整仓库内容仅在用户点击「安装/更新」后的 installExtension 中 clone。
         */
        attachLazyVersionLoader(selectEl, name, currentVersion) {
            let loaded = false;
            let loading = false;
            const load = () => {
                if (loaded || loading)
                    return;
                loading = true;
                void this.loadVersionsForSelect(name, selectEl, currentVersion)
                    .then((ok) => {
                    loaded = ok;
                })
                    .finally(() => {
                    loading = false;
                });
            };
            // 面板打开后立即拉取远程版本（来自 tags）
            load();
            selectEl.addEventListener('focus', load);
            selectEl.addEventListener('mousedown', load);
        },
        /** 异步拉远程 tag 引用填入下拉（无 clone；含本插件，与其他扩展一致） */
        async loadVersionsForSelect(name, selectEl, currentVersion) {
            try {
                const remote = await Editor.Message.request('extensions-manager', 'fetch-tags', name);
                const cur = (currentVersion === null || currentVersion === void 0 ? void 0 : currentVersion.trim()) || '';
                const ordered = [];
                const seen = new Set();
                if (cur) {
                    ordered.push(cur);
                    seen.add(cur);
                }
                for (const r of remote || []) {
                    if (r && !seen.has(r)) {
                        seen.add(r);
                        ordered.push(r);
                    }
                }
                if (ordered.length === 0)
                    return false;
                const prev = selectEl.value;
                selectEl.innerHTML = '';
                for (const tag of ordered) {
                    const opt = document.createElement('option');
                    opt.value = tag;
                    opt.textContent = tag;
                    selectEl.appendChild(opt);
                }
                if (prev && ordered.includes(prev)) {
                    selectEl.value = prev;
                }
                else if (cur && ordered.includes(cur)) {
                    selectEl.value = cur;
                }
                return true;
            }
            catch (err) {
                console.warn(`[extensions-manager] 获取 ${name} 版本列表失败:`, err.message || err);
                return false;
            }
        },
        async doInstall(name, version) {
            const target = version ? `${name}@${version}` : name;
            this.log(`安装 ${target} ...`);
            this._setItemLoading(name, true, '安装中...');
            this.beginBlockingOperation({
                title: '正在安装...',
                hint: '请稍候，正在拉取并安装扩展...',
            });
            try {
                const result = await Editor.Message.request('extensions-manager', 'install-extension', target);
                if (result.success) {
                    this.log(`✓ ${name} 安装成功`);
                }
                else {
                    this.log(`✗ ${name} 安装失败:\n${result.output}`);
                }
            }
            catch (err) {
                this.log(`✗ ${name} 安装异常: ${err.message || err}`);
            }
            finally {
                this._setItemLoading(name, false);
                this.endBlockingOperation();
                this.refreshList();
            }
        },
        async doUninstall(name) {
            this.log(`卸载 ${name} ...`);
            this._setItemLoading(name, true, '卸载中...');
            this.beginBlockingOperation({
                title: '正在卸载...',
                hint: '请稍候，正在移除扩展...',
            });
            try {
                const result = await Editor.Message.request('extensions-manager', 'uninstall-extension', name);
                if (result.success) {
                    this.log(`✓ ${name} 卸载成功`);
                }
                else {
                    this.log(`✗ ${name} 卸载失败:\n${result.output}`);
                }
            }
            catch (err) {
                this.log(`✗ ${name} 卸载异常: ${err.message || err}`);
            }
            finally {
                this._setItemLoading(name, false);
                this.endBlockingOperation();
                this.refreshList();
            }
        },
        async doSync() {
            this.log('同步所有扩展 ...');
            this.setButtonsEnabled(false);
            this.beginBlockingOperation({
                title: '正在同步...',
                hint: '请稍候，正在按各扩展 package.json 的 version 重新拉取...',
            });
            try {
                const result = await Editor.Message.request('extensions-manager', 'sync-all', false);
                if (result.success) {
                    this.log('✓ 同步完成');
                }
                else {
                    this.log(`同步结果:\n${result.output}`);
                }
            }
            catch (err) {
                this.log(`✗ 同步异常: ${err.message || err}`);
            }
            finally {
                this.setButtonsEnabled(true);
                this.endBlockingOperation();
                this.refreshList();
            }
        },
        /** 设置单个扩展条目的 loading 状态 */
        _setItemLoading(name, loading, btnText) {
            if (loading) {
                this._operatingItems.add(name);
            }
            else {
                this._operatingItems.delete(name);
            }
            const listEl = this.$.extList;
            const item = listEl.querySelector(`[data-ext-name="${name}"]`);
            if (!item)
                return;
            if (loading) {
                item.classList.add('item-loading');
                // 禁用该条目的所有按钮，并更新文字
                const btns = item.querySelectorAll('button');
                btns.forEach((btn) => {
                    btn.disabled = true;
                    if (btnText)
                        btn.textContent = btnText;
                });
            }
            else {
                item.classList.remove('item-loading');
            }
        },
        setButtonsEnabled(enabled) {
            const btns = this.$.extList.querySelectorAll('button');
            btns.forEach((btn) => btn.disabled = !enabled);
            this.$.btnSync.disabled = !enabled;
            this.$.btnRefresh.disabled = !enabled;
        },
    },
    ready() {
        var _a, _b, _c, _d;
        // 初始化实例属性（定义在顶层的属性不会自动挂到 this 上）
        this._refreshTimer = null;
        this._searchTimer = null;
        this._isFirstLoad = true;
        this._operatingItems = new Set();
        this._blockingOpCount = 0;
        this._operationTimeoutId = null;
        this._registrySyncGen = 0;
        (_a = this.$.registrySyncCancel) === null || _a === void 0 ? void 0 : _a.addEventListener('click', () => {
            this.onRegistrySyncCancel();
        });
        this.$.btnRefresh.addEventListener('click', () => {
            this.log('正在从远程更新扩展注册表…');
            this.runRegistryRefreshWithProgress({ reloadSelf: true });
        });
        this.$.btnSync.addEventListener('click', () => {
            this.doSync();
        });
        this.$.btnClearLog.addEventListener('click', () => {
            const logEl = this.$.logOutput;
            if (logEl)
                logEl.innerHTML = '';
        });
        (_b = this.$.btnCopyLog) === null || _b === void 0 ? void 0 : _b.addEventListener('click', () => {
            void this.copyLogs();
        });
        const searchEl = this.$.searchPlugins;
        if (searchEl) {
            const onSearch = () => this.applySearchFilter();
            searchEl.addEventListener('input', () => {
                if (this._searchTimer)
                    clearTimeout(this._searchTimer);
                this._searchTimer = setTimeout(onSearch, 200);
            });
        }
        const verEl = this.$.sidebarVersion;
        if (verEl)
            verEl.textContent = `v${pkgJson.version || '?'}`;
        this.applyLogSectionVisibility(this.isLogSectionVisible());
        (_c = this.$.navScrollLogs) === null || _c === void 0 ? void 0 : _c.addEventListener('click', () => {
            this.toggleLogSection();
        });
        (_d = this.$.navHelp) === null || _d === void 0 ? void 0 : _d.addEventListener('click', () => {
            this.log('帮助：列表仅包含远程注册表与本地 extensions 目录中均存在的扩展；右键条目可打开插件目录；「同步全部」按各扩展 package.json 的 version 重新拉取对应版本。');
        });
        // ── 右键菜单初始化 ──
        const ctxMenu = this.$.ctxMenu;
        this._ctxMenu = ctxMenu;
        this._ctxTarget = null;
        document.addEventListener('click', () => { ctxMenu.style.display = 'none'; });
        document.addEventListener('contextmenu', (e) => {
            const target = e.target;
            if (!target.closest('.ext-item'))
                ctxMenu.style.display = 'none';
        });
        this.$.ctxOpenDir.addEventListener('click', (e) => {
            e.stopPropagation();
            ctxMenu.style.display = 'none';
            const name = this._ctxTarget;
            if (!name)
                return;
            Editor.Message.request('extensions-manager', 'open-extension-dir', name)
                .then((result) => { if (!result.success)
                this.log(`⚠ ${result.output}`); })
                .catch((err) => {
                const message = String((err === null || err === void 0 ? void 0 : err.message) || err || '');
                if (message.includes('Message does not exist')) {
                    this.log('⚠ 当前扩展版本不支持“打开目录”功能，请先重载扩展');
                    return;
                }
                this.log(`⚠ 打开目录失败: ${message}`);
            });
        });
        // 初始加载：模态仅覆盖「本地列表 + 核心版本」（较快）；远程 registry 在后台拉取（优先 SSH 部分克隆仅取 registry.json）
        this.log('扩展管理器已就绪');
        void (async () => {
            this.beginBlockingOperation({
                title: '正在加载',
                hint: '正在读取扩展列表与核心版本信息…',
            });
            try {
                if (this._refreshTimer) {
                    clearTimeout(this._refreshTimer);
                    this._refreshTimer = null;
                }
                this._isFirstLoad = false;
                const listOnce = this._doRefreshList();
                await Promise.all([this.loadSelfInfo(), listOnce]);
            }
            finally {
                this.endBlockingOperation();
            }
            this.log('正在从远程更新扩展注册表…');
            this.runRegistryRefreshWithProgress();
        })();
    },
    beforeClose() {
        this._blockingOpCount = 0;
        this._clearOperationTimeout();
        this._registrySyncGen = (this._registrySyncGen || 0) + 1;
        this._hideRegistrySyncBar();
        const overlay = this.$.operationOverlay;
        if (overlay) {
            overlay.hidden = true;
            overlay.setAttribute('aria-hidden', 'true');
        }
    },
    close() { },
});
