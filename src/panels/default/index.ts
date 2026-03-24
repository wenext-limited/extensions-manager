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
        show() { },
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

        async refreshList() {
            const showAll = (this.$.showAll as HTMLInputElement).checked;
            const listEl = this.$.extList as HTMLElement;
            listEl.innerHTML = '<div class="loading">加载中...</div>';

            try {
                const msgName = showAll ? 'list-all' : 'list-project';
                const extensions: ExtensionInfo[] = await Editor.Message.request('extensions-manager', msgName);

                if (!extensions || extensions.length === 0) {
                    listEl.innerHTML = '<div class="loading">无扩展数据</div>';
                    return;
                }

                listEl.innerHTML = '';
                for (const ext of extensions) {
                    listEl.appendChild(this.createExtItem(ext));
                }
            } catch (err: any) {
                listEl.innerHTML = `<div class="loading">加载失败: ${err.message || err}</div>`;
            }
        },

        createExtItem(ext: ExtensionInfo): HTMLElement {
            const item = document.createElement('div');
            item.className = 'ext-item';

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

                // 异步加载版本列表
                this.loadVersionsForSelect(ext.name, vSelect, ext.requiredVersion);

                // 安装/更新按钮
                const actionBtn = document.createElement('button');
                actionBtn.className = ext.status === 'need_update' ? 'btn btn-primary' : 'btn btn-install';
                actionBtn.textContent = ext.status === 'need_update' ? '更新' : '安装';
                actionBtn.addEventListener('click', () => {
                    const ver = vSelect.value.trim();
                    this.doInstall(ext.name, ver);
                });
                actions.appendChild(actionBtn);
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

        /** 异步加载某个扩展的所有可用版本到下拉列表 */
        async loadVersionsForSelect(name: string, selectEl: HTMLSelectElement, currentVersion: string | null) {
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
            this.setButtonsEnabled(false);

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

            this.setButtonsEnabled(true);
            this.refreshList();
        },

        async doUninstall(name: string) {
            this.log(`卸载 ${name} ...`);
            this.setButtonsEnabled(false);

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

            this.setButtonsEnabled(true);
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

        setButtonsEnabled(enabled: boolean) {
            const btns = (this.$.extList as HTMLElement).querySelectorAll('button');
            btns.forEach((btn: HTMLButtonElement) => btn.disabled = !enabled);
            (this.$.btnSync as HTMLButtonElement).disabled = !enabled;
        },
    },

    ready() {
        (this.$.showAll as HTMLInputElement).addEventListener('change', () => {
            this.refreshList();
        });

        (this.$.btnRefresh as HTMLButtonElement).addEventListener('click', () => {
            this.refreshList();
        });

        (this.$.btnSync as HTMLButtonElement).addEventListener('click', () => {
            this.doSync();
        });

        (this.$.btnClearLog as HTMLButtonElement).addEventListener('click', () => {
            (this.$.logOutput as HTMLTextAreaElement).value = '';
        });

        // 初始加载
        this.refreshList();
        this.log('wenext扩展管理器已就绪');
    },

    beforeClose() { },
    close() { },
});
