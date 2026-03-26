import { readFileSync } from 'fs';
import { join } from 'path';

interface ExtensionInfo {
    name: string;
    description: string;
    git: string;
    requiredVersion: string | null;
    installedVersion: string | null;
    status: 'synced' | 'need_update' | 'not_installed' | 'not_in_manifest';
}

module.exports = Editor.Panel.define({
    listeners: {
        show() {
            if ((this as any)._isFirstLoad === false && this.log) {
                this.log('面板已显示，正在从远程更新扩展注册表...');
                (async () => {
                    try {
                        const result = await Editor.Message.request('extensions-manager', 'refresh-registry');
                        if (result.success) {
                            this.log(`✓ ${result.output}`);
                        } else {
                            this.log(`⚠ ${result.output}`);
                        }
                    } catch (err: any) {
                        this.log(`⚠ 更新注册表异常: ${err.message || err}`);
                    }
                    this.refreshList();
                })();
            }
        },
        hide() { },
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        extList: '#ext-list',
        showAll: '#show-all',
        btnSync: '#btn-sync',
        btnRefresh: '#btn-refresh',
        logOutput: '#log-output',
        btnClearLog: '#btn-clear-log',
    },

    methods: {
        log(message: string) {
            const el = this.$.logOutput as HTMLTextAreaElement;
            if (!el) return;
            const ts = new Date().toLocaleTimeString();
            el.value += `[${ts}] ${message}\n`;
            el.scrollTop = el.scrollHeight;
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

                if (!extensions || extensions.length === 0) {
                    listEl.innerHTML = '<div class="loading">无扩展数据</div>';
                    return;
                }

                // 用 DocumentFragment 构建新列表，然后一次性替换
                const fragment = document.createDocumentFragment();
                for (const ext of extensions) {
                    fragment.appendChild(this.createExtItem(ext));
                }

                // 一次性替换所有子节点（无闪烁）
                listEl.innerHTML = '';
                listEl.appendChild(fragment);
            } catch (err: any) {
                listEl.innerHTML = `<div class="loading">加载失败: ${err.message || err}</div>`;
            }
        },

        createExtItem(ext: ExtensionInfo): HTMLElement {
            const item = document.createElement('div');
            item.className = 'ext-item';
            item.dataset.extName = ext.name;

            // 若当前正在操作，加上 loading 样式
            if ((this as any)._operatingItems && (this as any)._operatingItems.has(ext.name)) {
                item.classList.add('item-loading');
            }

            // ── 信息区 ──
            const info = document.createElement('div');
            info.className = 'ext-info';

            const nameRow = document.createElement('div');
            const nameSpan = document.createElement('span');
            nameSpan.className = 'ext-name';
            nameSpan.textContent = ext.name;
            nameRow.appendChild(nameSpan);

            // 状态标签
            const badge = document.createElement('span');
            badge.className = 'status-badge';
            switch (ext.status) {
                case 'synced':
                    badge.className += ' status-synced';
                    badge.textContent = '已同步';
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
            nameRow.appendChild(badge);
            info.appendChild(nameRow);

            if (ext.description) {
                const desc = document.createElement('div');
                desc.className = 'ext-desc';
                desc.textContent = ext.description;
                info.appendChild(desc);
            }
            item.appendChild(info);

            // ── 版本区 ──
            const versionEl = document.createElement('div');
            versionEl.className = 'ext-version';
            let versionText = '';
            if (ext.installedVersion && ext.requiredVersion) {
                if (ext.status === 'need_update') {
                    versionText = `v${ext.installedVersion} → ${ext.requiredVersion}`;
                } else {
                    versionText = `v${ext.installedVersion}`;
                }
            } else if (ext.installedVersion) {
                versionText = `v${ext.installedVersion}`;
            } else if (ext.requiredVersion) {
                versionText = ext.requiredVersion;
            } else {
                versionText = '-';
            }
            const vSpan = document.createElement('span');
            vSpan.className = 'ext-version-text';
            vSpan.textContent = versionText;
            versionEl.appendChild(vSpan);
            item.appendChild(versionEl);

            // ── 操作区 ──
            const actions = document.createElement('div');
            actions.className = 'ext-actions';

            if (ext.status === 'not_installed' || ext.status === 'need_update') {
                // 版本下拉列表
                const vSelect = document.createElement('select');
                vSelect.className = 'version-select';
                // 先放一个默认选项
                const defaultOpt = document.createElement('option');
                defaultOpt.value = ext.requiredVersion || '';
                defaultOpt.textContent = ext.requiredVersion || '选择版本';
                vSelect.appendChild(defaultOpt);
                actions.appendChild(vSelect);

                // 安装/更新按钮（立即可用，不等版本加载）
                const actionBtn = document.createElement('button');
                actionBtn.className = ext.status === 'need_update' ? 'btn btn-primary' : 'btn btn-install';
                actionBtn.textContent = ext.status === 'need_update' ? '更新' : '安装';
                actionBtn.disabled = false;
                actionBtn.addEventListener('click', () => {
                    const ver = vSelect.value.trim();
                    this.doInstall(ext.name, ver);
                });
                actions.appendChild(actionBtn);

                // 异步加载版本列表（后台填充下拉框，不阻塞按钮）
                this.loadVersionsForSelect(ext.name, vSelect, ext.requiredVersion);
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

            item.appendChild(actions);
            return item;
        },

        /** 异步加载某个扩展的所有可用版本到下拉列表（纯后台操作，不阻塞 UI） */
        async loadVersionsForSelect(
            name: string,
            selectEl: HTMLSelectElement,
            currentVersion: string | null,
        ) {
            try {
                const tags: string[] = await Editor.Message.request('extensions-manager', 'fetch-tags', name);

                if (!tags || tags.length === 0) return;

                // 清空旧选项
                selectEl.innerHTML = '';
                for (const tag of tags) {
                    const opt = document.createElement('option');
                    opt.value = tag;
                    opt.textContent = tag;
                    if (currentVersion && tag === currentVersion) {
                        opt.selected = true;
                    }
                    selectEl.appendChild(opt);
                }

                // 如果 currentVersion 不在 tags 中，选中第一个（最新）
                if (currentVersion && !tags.includes(currentVersion)) {
                    selectEl.value = tags[0];
                }
            } catch (err: any) {
                console.warn(`[extensions-manager] 获取 ${name} 版本列表失败:`, err.message || err);
            }
        },

        async doInstall(name: string, version: string) {
            const target = version ? `${name}@${version}` : name;
            this.log(`安装 ${target} ...`);
            this._setItemLoading(name, true, '安装中...');

            try {
                const result = await Editor.Message.request('extensions-manager', 'install-extension', target);
                if (result.success) {
                    this.log(`✓ ${name} 安装成功`);
                } else {
                    this.log(`✗ ${name} 安装失败:\n${result.output}`);
                }
            } catch (err: any) {
                this.log(`✗ ${name} 安装异常: ${err.message || err}`);
            }

            this._setItemLoading(name, false);
            this.refreshList();
        },

        async doUninstall(name: string) {
            this.log(`卸载 ${name} ...`);
            this._setItemLoading(name, true, '卸载中...');

            try {
                const result = await Editor.Message.request('extensions-manager', 'uninstall-extension', name);
                if (result.success) {
                    this.log(`✓ ${name} 卸载成功`);
                } else {
                    this.log(`✗ ${name} 卸载失败:\n${result.output}`);
                }
            } catch (err: any) {
                this.log(`✗ ${name} 卸载异常: ${err.message || err}`);
            }

            this._setItemLoading(name, false);
            this.refreshList();
        },

        async doSync() {
            this.log('同步所有扩展 ...');
            this.setButtonsEnabled(false);

            try {
                const result = await Editor.Message.request('extensions-manager', 'sync-all', false);
                if (result.success) {
                    this.log('✓ 同步完成');
                } else {
                    this.log(`同步结果:\n${result.output}`);
                }
            } catch (err: any) {
                this.log(`✗ 同步异常: ${err.message || err}`);
            }

            this.setButtonsEnabled(true);
            this.refreshList();
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
        },
    },

    ready() {
        // 初始化实例属性（定义在顶层的属性不会自动挂到 this 上）
        (this as any)._refreshTimer = null;
        (this as any)._isFirstLoad = true;
        (this as any)._operatingItems = new Set<string>();

        (this.$.showAll as HTMLInputElement).addEventListener('change', () => {
            this.refreshList();
        });

        (this.$.btnRefresh as HTMLButtonElement).addEventListener('click', async () => {
            this.log('正在从远程更新扩展注册表...');
            try {
                const result = await Editor.Message.request('extensions-manager', 'refresh-registry');
                if (result.success) {
                    this.log(`✓ ${result.output}`);
                } else {
                    this.log(`⚠ ${result.output}`);
                }
            } catch (err: any) {
                this.log(`⚠ 更新注册表异常: ${err.message || err}`);
            }
            this.refreshList();
        });

        (this.$.btnSync as HTMLButtonElement).addEventListener('click', () => {
            this.doSync();
        });

        (this.$.btnClearLog as HTMLButtonElement).addEventListener('click', () => {
            (this.$.logOutput as HTMLTextAreaElement).value = '';
        });

        // 初始加载：先拉取远程注册表，再刷新列表
        this.log('wenext扩展管理器已就绪');
        (async () => {
            try {
                const result = await Editor.Message.request('extensions-manager', 'refresh-registry');
                if (result.success) {
                    this.log(`✓ ${result.output}`);
                } else {
                    this.log(`⚠ ${result.output}`);
                }
            } catch (err: any) {
                this.log(`⚠ 更新注册表异常: ${err.message || err}`);
            }
            this.refreshList();
        })();
    },

    beforeClose() { },
    close() { },
});
