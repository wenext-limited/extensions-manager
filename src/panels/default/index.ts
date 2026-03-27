import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-ignore
const pkgJson = require('../../../package.json');

/** 长时间无响应时自动解除全屏遮挡，避免界面永久锁死 */
const OPERATION_OVERLAY_TIMEOUT_MS = 10 * 60 * 1000;

/** 远程注册表进度条：超时后请求主进程终止 git，避免无限等待 */
const REGISTRY_SYNC_UI_TIMEOUT_MS = 90 * 1000;

interface ExtensionInfo {
    name: string;
    description: string;
    git: string;
    requiredVersion: string | null;
    installedVersion: string | null;
    remoteLatestVersion?: string | null;
    status: 'synced' | 'need_update' | 'not_installed' | 'not_in_manifest';
}

function versionNorm(v: string): string {
    const t = v.trim();
    if (!t) return '';
    return t.startsWith('v') ? t.slice(1) : t;
}

/** 可更新时的推荐目标：优先 manifest 与本地不一致时的清单版本，否则用远程较新版本 */
function getUpgradeTarget(ext: ExtensionInfo): string | null {
    if (ext.status !== 'need_update') return null;
    const req = ext.requiredVersion?.trim() || '';
    const ins = ext.installedVersion?.trim() || '';
    if (req && ins && versionNorm(req) !== versionNorm(ins)) return ext.requiredVersion || null;
    if (ext.remoteLatestVersion) return ext.remoteLatestVersion;
    return ext.requiredVersion || null;
}

function displayVersionLabel(v: string): string {
    const t = v.trim();
    if (!t) return '';
    return t.startsWith('v') ? t : `v${t}`;
}

/** 图标方格内展示：取扩展名的首字母（ASCII 大写；中文取首字） */
function extensionNameInitial(name: string): string {
    const t = name.trim();
    if (!t) return '?';
    const ascii = t.match(/[a-zA-Z]/);
    if (ascii) return ascii[0].toUpperCase();
    const cjk = t.match(/[\u4e00-\u9fff]/);
    if (cjk) return cjk[0];
    return t[0].toUpperCase();
}

module.exports = Editor.Panel.define({
    listeners: {
        show() {
            if ((this as any)._isFirstLoad === false && this.log) {
                this.log('面板已显示，正在同步远程注册表…');
                void this.loadSelfInfo();
                void this.refreshList();
                this.runRegistryRefreshWithProgress();
            }
        },
        hide() { },
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        extList: '#ext-list',
        showAll: '#show-all',
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
        beginBlockingOperation(opts?: { title?: string; hint?: string }) {
            const overlay = this.$.operationOverlay as HTMLElement | null;
            const titleEl = this.$.operationOverlayTitle as HTMLElement | null;
            const hintEl = this.$.operationOverlayHint as HTMLElement | null;
            if (titleEl) {
                titleEl.textContent = opts?.title ?? '正在处理...';
            }
            if (hintEl) {
                hintEl.textContent = opts?.hint ?? '请稍候，操作正在进行中...';
            }
            (this as any)._blockingOpCount = ((this as any)._blockingOpCount || 0) + 1;
            if ((this as any)._blockingOpCount === 1 && overlay) {
                overlay.hidden = false;
                overlay.setAttribute('aria-hidden', 'false');
            }
            this._armOperationTimeout();
        },

        endBlockingOperation() {
            (this as any)._blockingOpCount = Math.max(0, ((this as any)._blockingOpCount || 0) - 1);
            if ((this as any)._blockingOpCount === 0) {
                this._clearOperationTimeout();
                const overlay = this.$.operationOverlay as HTMLElement | null;
                if (overlay) {
                    overlay.hidden = true;
                    overlay.setAttribute('aria-hidden', 'true');
                }
            }
        },

        _armOperationTimeout() {
            if ((this as any)._operationTimeoutId != null) {
                clearTimeout((this as any)._operationTimeoutId);
            }
            (this as any)._operationTimeoutId = setTimeout(() => {
                (this as any)._operationTimeoutId = null;
                if (((this as any)._blockingOpCount || 0) <= 0) return;
                (this as any)._blockingOpCount = 0;
                const overlay = this.$.operationOverlay as HTMLElement | null;
                if (overlay) {
                    overlay.hidden = true;
                    overlay.setAttribute('aria-hidden', 'true');
                }
                this.setButtonsEnabled(true);
                try {
                    (this as any)._operatingItems.clear();
                } catch {
                    /* ignore */
                }
                this.log('⚠ 操作等待超时，已解除界面锁定（若命令仍在后台运行，请稍后手动刷新列表）');
                this.refreshList();
            }, OPERATION_OVERLAY_TIMEOUT_MS);
        },

        _clearOperationTimeout() {
            if ((this as any)._operationTimeoutId != null) {
                clearTimeout((this as any)._operationTimeoutId);
                (this as any)._operationTimeoutId = null;
            }
        },

        /** 加载并渲染插件管理器自身的版本状态 */
        appendSystemStatus(container: HTMLElement, ok: boolean, warn: boolean, text: string, title?: string) {
            const row = document.createElement('div');
            row.className = 'system-status';
            const dot = document.createElement('span');
            dot.className = 'system-status-dot' + (warn ? ' system-status-dot--warn' : '');
            if (!ok && !warn) dot.className = 'system-status-dot system-status-dot--warn';
            row.appendChild(dot);
            const t = document.createElement('span');
            t.textContent = text;
            if (title) t.title = title;
            row.appendChild(t);
            container.appendChild(row);
        },

        async loadSelfInfo() {
            const el = this.$.selfInfo as HTMLElement;
            if (!el) return;
            try {
                const info: ExtensionInfo = await Editor.Message.request('extensions-manager', 'get-self-info');
                el.innerHTML = '';
                el.className = 'core-version-row';

                const label = document.createElement('span');
                label.className = 'core-version-label';
                label.textContent = '核心系统版本:';
                el.appendChild(label);

                const localVer = info.installedVersion || pkgJson.version || '?';
                const pill = document.createElement('span');
                pill.className = 'version-pill';
                pill.textContent = `v${localVer}`;
                el.appendChild(pill);

                if (info.status === 'need_update') {
                    el.classList.add('has-update');

                    const vSelect = document.createElement('select');
                    vSelect.className = 'version-select';
                    const opt = document.createElement('option');
                    opt.value = info.requiredVersion || '';
                    opt.textContent = info.requiredVersion || '';
                    vSelect.appendChild(opt);
                    el.appendChild(vSelect);

                    const updateBtn = document.createElement('button');
                    updateBtn.className = 'btn btn-primary';
                    updateBtn.textContent = '更新';
                    updateBtn.addEventListener('click', () => this.doInstall(info.name, vSelect.value.trim()));
                    el.appendChild(updateBtn);

                    this.attachLazyVersionLoader(vSelect, info.name, info.requiredVersion);
                    this.appendSystemStatus(el, false, true, '插件可更新', info.requiredVersion || undefined);
                } else {
                    const badge = document.createElement('span');
                    badge.className = 'status-badge status-synced';
                    badge.textContent = '已是最新';
                    el.appendChild(badge);
                    this.appendSystemStatus(el, true, false, '系统运行正常');
                }

                el.style.display = 'flex';
            } catch (err: any) {
                const msg = String(err?.message || err || '');
                console.warn('[extensions-manager] loadSelfInfo 失败:', msg);
                el.innerHTML = '';
                el.className = 'core-version-row self-info-fallback';
                const label = document.createElement('span');
                label.className = 'core-version-label';
                label.textContent = '核心系统版本:';
                el.appendChild(label);
                const pill = document.createElement('span');
                pill.className = 'version-pill';
                pill.textContent = `v${pkgJson.version || '?'}`;
                el.appendChild(pill);
                const hint = document.createElement('span');
                hint.className = 'status-badge status-not-installed';
                const short =
                    msg.includes('Message does not exist') || msg.includes('Method does not exist')
                        ? '无法检查远程版本：请在扩展目录执行 npm run build，重新打开 Cocos Creator 或完全重载本扩展'
                        : (msg.length > 120 ? `${msg.slice(0, 117)}…` : msg);
                hint.textContent = short || '无法检查远程版本';
                hint.title = msg;
                el.appendChild(hint);
                this.appendSystemStatus(el, false, true, '版本检查异常', msg);
                el.style.display = 'flex';
                try {
                    this.log(`⚠ 插件自身版本信息：${hint.textContent}`);
                } catch { /* ignore */ }
            }
        },

        async tryRefreshRegistry() {
            try {
                const result = await Editor.Message.request('extensions-manager', 'refresh-registry');
                if (result?.success) {
                    this.log(`✓ ${result.output}`);
                } else if (result?.output) {
                    this.log(`⚠ ${result.output}`);
                }
                return true;
            } catch (err: any) {
                const message = String(err?.message || err || '');
                if (message.includes('Message does not exist')) {
                    this.log('⚠ 当前扩展版本不支持远程刷新，已使用本地注册表');
                    return false;
                }
                this.log(`⚠ 更新注册表异常: ${message}`);
                return false;
            }
        },

        _showRegistrySyncBar() {
            const bar = this.$.registrySyncBar as HTMLElement | null;
            if (bar) bar.hidden = false;
            const t = this.$.registrySyncText as HTMLElement | null;
            if (t) t.textContent = '正在从远程更新扩展注册表…';
        },

        _hideRegistrySyncBar() {
            const bar = this.$.registrySyncBar as HTMLElement | null;
            if (bar) bar.hidden = true;
        },

        /**
         * 顶部进度条 + 可取消 + 界面 90s 超时（会 kill git）；正常结束后再刷新列表。
         */
        runRegistryRefreshWithProgress(opts?: { reloadSelf?: boolean }) {
            (this as any)._registrySyncGen = ((this as any)._registrySyncGen || 0) + 1;
            const gen = (this as any)._registrySyncGen;
            this._showRegistrySyncBar();

            const timeoutId = setTimeout(() => {
                if ((this as any)._registrySyncGen !== gen) return;
                (this as any)._registrySyncGen++;
                void Editor.Message.request('extensions-manager', 'cancel-fetch-registry')
                    .then((r: any) => {
                        if (r?.success) {
                            this.log('⚠ 远程注册表更新已超过等待时间，已中断拉取');
                        } else {
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
                } finally {
                    clearTimeout(timeoutId);
                    if ((this as any)._registrySyncGen === gen) {
                        this._hideRegistrySyncBar();
                        this.refreshList();
                        if (opts?.reloadSelf) void this.loadSelfInfo();
                    }
                }
            })();
        },

        onRegistrySyncCancel() {
            (this as any)._registrySyncGen = ((this as any)._registrySyncGen || 0) + 1;
            void Editor.Message.request('extensions-manager', 'cancel-fetch-registry')
                .then((r: any) => {
                    if (r?.success) this.log('已取消远程注册表更新');
                    else this.log('当前没有进行中的注册表拉取');
                })
                .catch(() => this.log('取消注册表更新失败'));
            this._hideRegistrySyncBar();
            this.refreshList();
        },

        log(message: string) {
            const el = this.$.logOutput as HTMLElement;
            if (!el) return;
            const ts = new Date().toLocaleTimeString();
            const line = document.createElement('div');
            line.className = 'log-line';
            if (message.includes('✓') || message.includes('成功')) line.classList.add('log-line--success');
            else if (message.includes('⚠')) line.classList.add('log-line--warn');
            else if (message.includes('✗')) line.classList.add('log-line--error');
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
            const el = this.$.logOutput as HTMLElement | null;
            if (!el) return;
            const text = el.innerText || '';
            if (!text.trim()) {
                this.log('⚠ 当前没有可复制的日志');
                return;
            }
            try {
                await navigator.clipboard.writeText(text);
                this.log('✓ 日志已复制到剪贴板');
            } catch {
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
                } catch {
                    ok = false;
                }
                document.body.removeChild(ta);
                if (ok) this.log('✓ 日志已复制到剪贴板');
                else this.log('⚠ 复制失败，请手动选中日志复制');
            }
        },

        isLogSectionVisible(): boolean {
            try {
                const v = localStorage.getItem('extensions-manager.logSectionVisible');
                if (v === null) return false;
                return v === '1' || v === 'true';
            } catch {
                return false;
            }
        },

        applyLogSectionVisibility(visible: boolean) {
            const wrap = this.$.logPanelWrap as HTMLElement | null;
            const btn = this.$.navScrollLogs as HTMLButtonElement | null;
            if (!wrap) return;
            wrap.hidden = !visible;
            if (btn) {
                btn.textContent = visible ? '隐藏日志' : '显示日志';
                btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
                btn.title = visible ? '隐藏操作日志区域' : '显示操作日志区域';
            }
            try {
                localStorage.setItem('extensions-manager.logSectionVisible', visible ? '1' : '0');
            } catch {
                /* ignore quota / private mode */
            }
        },

        toggleLogSection() {
            const wrap = this.$.logPanelWrap as HTMLElement | null;
            if (!wrap) return;
            const hidden = wrap.hidden;
            if (hidden) {
                this.applyLogSectionVisibility(true);
                wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else {
                this.applyLogSectionVisibility(false);
            }
        },

        /** 按搜索框过滤已渲染的扩展卡片 */
        applySearchFilter() {
            const input = this.$.searchPlugins as HTMLInputElement;
            const listEl = this.$.extList as HTMLElement;
            if (!input || !listEl) return;
            const q = input.value.trim().toLowerCase();
            listEl.querySelectorAll('.ext-item').forEach((node) => {
                const item = node as HTMLElement;
                const name = (item.dataset.extName || '').toLowerCase();
                const desc = (item.dataset.extDesc || '').toLowerCase();
                const match = !q || name.includes(q) || desc.includes(q);
                item.dataset.filterHidden = match ? '' : '1';
            });
        },

        /** 防抖刷新（300ms），首次加载立即执行 */
        refreshList() {
            if ((this as any)._refreshTimer) {
                clearTimeout((this as any)._refreshTimer);
            }
            if ((this as any)._isFirstLoad) {
                (this as any)._isFirstLoad = false;
                this._doRefreshList();
            } else {
                (this as any)._refreshTimer = setTimeout(() => {
                    this._doRefreshList();
                }, 300);
            }
        },

        /** 实际刷新逻辑：无闪烁 DOM 更新 */
        async _doRefreshList() {
            const showAll = (this.$.showAll as HTMLInputElement).checked;
            const listEl = this.$.extList as HTMLElement;

            // 首次加载时才显示 "加载中..."
            const isEmptyList = listEl.children.length === 0 ||
                (listEl.children.length === 1 && listEl.children[0].classList.contains('loading'));

            if (isEmptyList) {
                listEl.innerHTML = '<div class="loading">加载中...</div>';
            }

            try {
                const msgName = showAll ? 'list-all' : 'list-project';
                const extensions: ExtensionInfo[] = await Editor.Message.request('extensions-manager', msgName);
                const selfName = pkgJson.name as string;
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
            } catch (err: any) {
                listEl.innerHTML = `<div class="loading">加载失败: ${err.message || err}</div>`;
            }
        },

        createExtItem(ext: ExtensionInfo): HTMLElement {
            const item = document.createElement('div');
            item.className = 'ext-item';
            item.dataset.extName = ext.name;
            item.dataset.extDesc = ext.description || '';

            // 若当前正在操作，加上 loading 样式
            if ((this as any)._operatingItems && (this as any)._operatingItems.has(ext.name)) {
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
            } else {
                const single = document.createElement('span');
                single.className = 'ext-version-single';
                if (ext.installedVersion) {
                    single.textContent = `当前: v${ext.installedVersion}`;
                } else if (ext.requiredVersion) {
                    single.textContent = `目标: ${reqNorm}`;
                } else {
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
            item.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const menu = (this as any)._ctxMenu as HTMLElement;
                if (!menu) return;
                (this as any)._ctxTarget = ext.name;

                const openDirItem = menu.querySelector('#ctx-open-dir') as HTMLElement;
                if (ext.installedVersion) {
                    openDirItem.classList.remove('ctx-disabled');
                } else {
                    openDirItem.classList.add('ctx-disabled');
                }

                const mw = 150, mh = 38;
                let x = e.clientX, y = e.clientY;
                if (x + mw > window.innerWidth) x = window.innerWidth - mw - 4;
                if (y + mh > window.innerHeight) y = window.innerHeight - mh - 4;

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
        attachLazyVersionLoader(selectEl: HTMLSelectElement, name: string, currentVersion: string | null) {
            let loaded = false;
            let loading = false;
            const load = () => {
                if (loaded || loading) return;
                loading = true;
                void this.loadVersionsForSelect(name, selectEl, currentVersion)
                    .then((ok: boolean) => {
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
        async loadVersionsForSelect(
            name: string,
            selectEl: HTMLSelectElement,
            currentVersion: string | null,
        ): Promise<boolean> {
            try {
                const remote: string[] = await Editor.Message.request('extensions-manager', 'fetch-tags', name);

                const cur = currentVersion?.trim() || '';
                const ordered: string[] = [];
                const seen = new Set<string>();
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

                if (ordered.length === 0) return false;

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
                } else if (cur && ordered.includes(cur)) {
                    selectEl.value = cur;
                }
                return true;
            } catch (err: any) {
                console.warn(`[extensions-manager] 获取 ${name} 版本列表失败:`, err.message || err);
                return false;
            }
        },

        async doInstall(name: string, version: string) {
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
                } else {
                    this.log(`✗ ${name} 安装失败:\n${result.output}`);
                }
            } catch (err: any) {
                this.log(`✗ ${name} 安装异常: ${err.message || err}`);
            } finally {
                this._setItemLoading(name, false);
                this.endBlockingOperation();
                this.refreshList();
            }
        },

        async doUninstall(name: string) {
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
                } else {
                    this.log(`✗ ${name} 卸载失败:\n${result.output}`);
                }
            } catch (err: any) {
                this.log(`✗ ${name} 卸载异常: ${err.message || err}`);
            } finally {
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
                hint: '请稍候，正在按清单对齐扩展版本...',
            });

            try {
                const result = await Editor.Message.request('extensions-manager', 'sync-all', false);
                if (result.success) {
                    this.log('✓ 同步完成');
                } else {
                    this.log(`同步结果:\n${result.output}`);
                }
            } catch (err: any) {
                this.log(`✗ 同步异常: ${err.message || err}`);
            } finally {
                this.setButtonsEnabled(true);
                this.endBlockingOperation();
                this.refreshList();
            }
        },

        /** 设置单个扩展条目的 loading 状态 */
        _setItemLoading(name: string, loading: boolean, btnText?: string) {
            if (loading) {
                (this as any)._operatingItems.add(name);
            } else {
                (this as any)._operatingItems.delete(name);
            }

            const listEl = this.$.extList as HTMLElement;
            const item = listEl.querySelector(`[data-ext-name="${name}"]`) as HTMLElement;
            if (!item) return;

            if (loading) {
                item.classList.add('item-loading');
                // 禁用该条目的所有按钮，并更新文字
                const btns = item.querySelectorAll('button');
                btns.forEach((btn: HTMLButtonElement) => {
                    btn.disabled = true;
                    if (btnText) btn.textContent = btnText;
                });
            } else {
                item.classList.remove('item-loading');
            }
        },

        setButtonsEnabled(enabled: boolean) {
            const btns = (this.$.extList as HTMLElement).querySelectorAll('button');
            btns.forEach((btn: HTMLButtonElement) => btn.disabled = !enabled);
            (this.$.btnSync as HTMLButtonElement).disabled = !enabled;
            (this.$.btnRefresh as HTMLButtonElement).disabled = !enabled;
            (this.$.showAll as HTMLInputElement).disabled = !enabled;
        },
    },

    ready() {
        // 初始化实例属性（定义在顶层的属性不会自动挂到 this 上）
        (this as any)._refreshTimer = null;
        (this as any)._searchTimer = null;
        (this as any)._isFirstLoad = true;
        (this as any)._operatingItems = new Set<string>();
        (this as any)._blockingOpCount = 0;
        (this as any)._operationTimeoutId = null as ReturnType<typeof setTimeout> | null;
        (this as any)._registrySyncGen = 0;

        (this.$.showAll as HTMLInputElement).addEventListener('change', () => {
            this.refreshList();
        });

        (this.$.registrySyncCancel as HTMLButtonElement | null)?.addEventListener('click', () => {
            this.onRegistrySyncCancel();
        });

        (this.$.btnRefresh as HTMLButtonElement).addEventListener('click', () => {
            this.log('正在从远程更新扩展注册表…');
            this.runRegistryRefreshWithProgress({ reloadSelf: true });
        });

        (this.$.btnSync as HTMLButtonElement).addEventListener('click', () => {
            this.doSync();
        });

        (this.$.btnClearLog as HTMLButtonElement).addEventListener('click', () => {
            const logEl = this.$.logOutput as HTMLElement;
            if (logEl) logEl.innerHTML = '';
        });

        (this.$.btnCopyLog as HTMLButtonElement | null)?.addEventListener('click', () => {
            void this.copyLogs();
        });

        const searchEl = this.$.searchPlugins as HTMLInputElement;
        if (searchEl) {
            const onSearch = () => this.applySearchFilter();
            searchEl.addEventListener('input', () => {
                if ((this as any)._searchTimer) clearTimeout((this as any)._searchTimer);
                (this as any)._searchTimer = setTimeout(onSearch, 200);
            });
        }

        const verEl = this.$.sidebarVersion as HTMLElement;
        if (verEl) verEl.textContent = `v${pkgJson.version || '?'}`;

        this.applyLogSectionVisibility(this.isLogSectionVisible());

        (this.$.navScrollLogs as HTMLButtonElement | null)?.addEventListener('click', () => {
            this.toggleLogSection();
        });
        (this.$.navHelp as HTMLButtonElement | null)?.addEventListener('click', () => {
            this.log('帮助：勾选「显示全部」可浏览注册表内全部扩展；右键扩展条目可打开插件目录；「同步全部」按 extensions.json 对齐版本。');
        });

        // ── 右键菜单初始化 ──
        const ctxMenu = this.$.ctxMenu as HTMLElement;
        (this as any)._ctxMenu = ctxMenu;
        (this as any)._ctxTarget = null;

        document.addEventListener('click', () => { ctxMenu.style.display = 'none'; });
        document.addEventListener('contextmenu', (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('.ext-item')) ctxMenu.style.display = 'none';
        });

        (this.$.ctxOpenDir as HTMLElement).addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            ctxMenu.style.display = 'none';
            const name = (this as any)._ctxTarget as string;
            if (!name) return;
            Editor.Message.request('extensions-manager', 'open-extension-dir', name)
                .then((result: any) => { if (!result.success) this.log(`⚠ ${result.output}`); })
                .catch((err: any) => {
                    const message = String(err?.message || err || '');
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
                if ((this as any)._refreshTimer) {
                    clearTimeout((this as any)._refreshTimer);
                    (this as any)._refreshTimer = null;
                }
                (this as any)._isFirstLoad = false;

                const listOnce = this._doRefreshList();
                await Promise.all([this.loadSelfInfo(), listOnce]);
            } finally {
                this.endBlockingOperation();
            }
            this.log('正在从远程更新扩展注册表…');
            this.runRegistryRefreshWithProgress();
        })();
    },

    beforeClose() {
        (this as any)._blockingOpCount = 0;
        this._clearOperationTimeout();
        (this as any)._registrySyncGen = ((this as any)._registrySyncGen || 0) + 1;
        this._hideRegistrySyncBar();
        const overlay = this.$.operationOverlay as HTMLElement | null;
        if (overlay) {
            overlay.hidden = true;
            overlay.setAttribute('aria-hidden', 'true');
        }
    },
    close() { },
});
