import { APP_VERSION } from '@shared/appVersion';
import { BackupPanel } from './BackupPanel';
import { useState, useEffect } from 'react';
import { useFormDraft } from '../../store/useFormDraft';
import { isolateDrafts } from '../../store/useDraft';
import { providerDraftFields } from '../../store/providerDraft';
import { DraftStatus } from '../../components/DraftStatus';
import { useApp, tryApi } from '../../store/app';
import { api } from '../../api';
import { Switch, ConfirmDestructive } from '../../components/ui';
import { Trash2, AlertTriangle } from 'lucide-react';
import type { ProviderSettings, ProjectSettings } from '@shared/types';

// Unsaved secret survives page switches only in memory; never enters the draft store.
let pendingApiKey = '';
window.addEventListener('beforeunload', e => { if (pendingApiKey) { e.preventDefault(); e.returnValue = ''; } });

export function SettingsPage() {
  const { provider, projectSettings, currentSeriesId, theme, setTheme, refreshProvider, refreshSeries, toast } = useApp();
  const form = useFormDraft('provider', providerDraftFields(provider ?? {}), { page: 'settings', title: '接口设置（不含密钥）' });
  const [apiKey, setApiKey] = useState(pendingApiKey);
  const f = { ...form.value, apiKey };
  const setF = (next: typeof f) => { if (form.busy) return; if (next.apiKey !== apiKey) { pendingApiKey = next.apiKey; setApiKey(next.apiKey); } if (JSON.stringify(providerDraftFields(next)) !== JSON.stringify(form.value)) form.change(providerDraftFields(next)); };
  const [testing, setTesting] = useState(false);
  const [movingData, setMovingData] = useState(false);
  const [dataDirectory, setDataDirectory] = useState('');
  useEffect(() => { let active=true; void api.app.getDataDirectory().then(path=>{if(active)setDataDirectory(path);}).catch(()=>{if(active)setDataDirectory('暂时无法读取目录');}); return ()=>{active=false;}; }, []);
  const [resetOpen, setResetOpen] = useState(false);
  const projectForm = useFormDraft('project-settings', {
    'ruby.first_person': projectSettings?.['ruby.first_person'] ?? false,
    'ruby.proper_noun': projectSettings?.['ruby.proper_noun'] ?? false,
    'honorific.default_style': projectSettings?.['honorific.default_style'] ?? 'loan',
    'export.bilingual_layout': projectSettings?.['export.bilingual_layout'] ?? 'jp-top',
    'export.translate_title': projectSettings?.['export.translate_title'] ?? false,
  }, { page: 'settings', ...(currentSeriesId ? { seriesId: currentSeriesId } : {}), title: '当前系列设置' });
  const set = <K extends keyof typeof projectForm.value>(k: K, v: (typeof projectForm.value)[K]): void => { projectForm.change({ ...projectForm.value, [k]: v }); };
  if (!provider) return null;
  const dirty = JSON.stringify({ ...provider, ...f, apiKey: undefined }) !== JSON.stringify({ ...provider, apiKey: undefined }) || !!f.apiKey;
  return (
    <>
      <div className="page-header"><h1>设置</h1></div>
      <div className="page-body"><div className="settings"><div className="settings-primary">


        <fieldset className="card" disabled={form.busy} style={{ minWidth: 0 }}><h3>AI 接口</h3>
          <p className="small muted">第一次使用：按服务商提供的信息填写协议、接口地址和 API 密钥，点击“保存”，再“测试连接”。测试连接也会发送一次 AI 请求，可能产生少量费用；连接成功只说明接口能响应，不代表译文质量已通过验证。</p>
          <div className="grid2">
            <div className="field"><label>协议</label><select className="input" value={f.protocol ?? 'chat-completions'} onChange={e => setF({ ...f, protocol: e.target.value as ProviderSettings['protocol'] })}><option value="chat-completions">OpenAI 兼容 chat/completions（DeepSeek、通义、Ollama…）</option><option value="responses">OpenAI Responses API</option><option value="anthropic-messages">Anthropic Messages</option></select></div>
            <div className="field"><label>鉴权方式</label><select className="input" value={f.authScheme ?? 'bearer'} onChange={e => setF({ ...f, authScheme: e.target.value as ProviderSettings['authScheme'] })}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="none">无</option></select></div>
          </div>
          <div className="field"><label>接口地址（Base URL）</label><input className="input mono" value={f.baseUrl ?? ''} onChange={e => setF({ ...f, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" /></div>
          <div className="field"><label>API 密钥 {provider.hasApiKey && <span className="faint">（已保存，留空则不修改）</span>}</label><input className="input mono" type="password" value={f.apiKey ?? ''} onChange={e => setF({ ...f, apiKey: e.target.value })} placeholder={provider.hasApiKey ? '••••••••' : 'sk-…'} autoComplete="off" /></div>
          <div className="grid2">
            <div className="field"><label>模型</label><input className="input mono" readOnly value={f.model ?? ''} onChange={e => setF({ ...f, model: e.target.value })} /></div>
            <div className="field"><label>质量检查模型（与翻译相同）</label><input className="input mono" readOnly value={f.judgeModel ?? ''} onChange={e => setF({ ...f, judgeModel: e.target.value })} placeholder="DeepSeek V4.1 Flash" /></div>
            <div className="field"><label>温度</label><input className="input" type="number" step={0.1} min={0} max={2} value={f.temperature ?? 0.2} onChange={e => setF({ ...f, temperature: Number(e.target.value) })} /></div>
            <div className="field"><label>基础输出额度（token）</label><input className="input" type="number" min={1024} value={f.maxOutputTokens ?? 8192} onChange={e => setF({ ...f, maxOutputTokens: Number(e.target.value) })} /><span className="hint">正文和关键审校至少预留 8192，包含思考与译文。</span></div>
            <div className="field"><label>并发数</label><input className="input" type="number" min={1} max={16} value={f.concurrency ?? 3} onChange={e => setF({ ...f, concurrency: Number(e.target.value) })} /><span className="hint">不同场景可以同时处理，同一场景内按顺序</span></div>
            <div className="field"><label>超时（秒）</label><input className="input" type="number" min={30} value={Math.round((f.timeoutMs ?? 180000) / 1000)} onChange={e => setF({ ...f, timeoutMs: Number(e.target.value) * 1000 })} /></div>
          </div>
          <p className="hint">官方 DeepSeek V4.1 Flash：正文翻译、编辑和关键审校使用高思考（high）；预处理、版式、对齐及章内连读等基础环节关闭思考（disabled）。系统自动分配，无需逐项设置。</p>
          <p className="hint">上述分阶段策略只对官方 API 验证过；第三方接口未做实验，是否接受或执行这些设置不能保证。运行记录显示每次调用的模型、思考配置和脱敏密钥尾四位，不保存完整密钥。</p>
          <div style={{ height: 8 }}></div>
          <DraftStatus draft={form} />
          {apiKey && <p className="hint">未保存密钥仅暂留当前进程，切换页面会保留，退出后不会保存。<button className="btn btn-text btn-sm" disabled={form.busy} onClick={() => { pendingApiKey = ''; setApiKey(''); }}>清除未保存密钥</button></p>}
          <div className="row"><button className="btn btn-primary" disabled={!dirty || form.busy || form.conflict} onClick={async () => { if (!await form.save(() => api.app.setProviderSettings(f), '已保存')) return; pendingApiKey = ''; setApiKey(''); await refreshProvider(); }}>保存</button>
            <button className="btn btn-secondary" disabled={testing || dirty} onClick={async () => { setTesting(true); const r = await tryApi(() => api.app.testProvider()); setTesting(false); if (r) toast(r.ok ? 'success' : 'error', `${r.ok ? '连接成功' : '连接失败'}（${r.latencyMs}ms）：${r.message}`); }}>{testing ? '测试中…' : '测试连接'}</button>{dirty && <span className="small faint">先保存再测试</span>}</div>
        </fieldset>

      </div><div className="settings-secondary">
        <div className="card"><h3>数据位置</h3><p className="hint">书库、设置、日志、缓存和软件临时文件默认保存在程序旁的 data 文件夹。可选择其他目录；更换前请保存正在编辑的内容。迁移时程序会重启，校验复制结果后使用新目录，原目录保留作备份。</p><p className="small mono" style={{overflowWrap: 'anywhere'}}>{dataDirectory || '正在读取…'}</p><button className="btn btn-secondary" disabled={movingData || dirty || form.busy || projectForm.busy} onClick={async () => { setMovingData(true); try { const target = await api.app.chooseDataDirectory(); if (target) toast('success', '正在重启并迁移数据，请稍候'); else setMovingData(false); } catch (e) { toast('error', (e as Error).message); setMovingData(false); } }}>{movingData ? '正在迁移…' : '选择目录并重启'}</button><p className="hint">完整密钥由 Windows 系统加密保存；日志仅显示 **** 加尾四位。换电脑后可能需要重新填写密钥。</p></div>
        <div className="card"><h3>外观</h3><div className="row"><button className={`chip${theme === 'light' ? ' on' : ''}`} onClick={() => setTheme('light')}>浅色</button><button className={`chip${theme === 'dark' ? ' on' : ''}`} onClick={() => setTheme('dark')}>深色</button></div></div>
        {projectSettings && currentSeriesId && <fieldset className="card" disabled={projectForm.busy} style={{ minWidth: 0 }}><h3>当前系列设置</h3>
          <DraftStatus draft={projectForm} />
          <p className="hint">修改暂存为草稿，点击“保存系列设置”后生效。若部分项目保存失败，会保留整份输入；请对照已保存值后重试。</p>
          <button className="btn btn-primary btn-sm" disabled={!projectForm.stored || projectForm.busy || projectForm.conflict} onClick={() => projectForm.save(async () => {
            for (const key of Object.keys(projectForm.value) as (keyof typeof projectForm.value)[]) {
              if (projectForm.value[key] !== projectSettings[key]) await api.project.setSetting(currentSeriesId, key, projectForm.value[key]);
            }
          }, '系列设置已保存')}>保存系列设置</button>
          <div className="field"><Switch checked={projectForm.value['ruby.first_person']} onChange={v => set('ruby.first_person', v)} label="给“我”添加罗马音注音" /><span className="hint">首次出现或自称改变时，在“我”旁标注 boku、ore 等罗马音；稳定时不重复。</span></div>
          <div className="field"><Switch checked={projectForm.value['ruby.proper_noun']} onChange={v => set('ruby.proper_noun', v)} label="专名读音 ruby 标注" /></div>
          <div className="field"><label>称呼翻译方式</label><select className="input" value={projectForm.value['honorific.default_style']} onChange={e => set('honorific.default_style', e.target.value as ProjectSettings['honorific.default_style'])}><option value="loan">保留日式称呼（桑 / 君 / 酱）</option><option value="native">按人物关系译成中文</option></select><span className="hint">保留模式固定使用桑、君、酱，不自动换成先生或同学；中文模式依据关系和场景选择，无法确定时请你确认。已确认的具体称呼优先。</span></div>
          <div className="field"><label>翻译质量把关</label><span className="hint">检查有没有漏翻、多翻、称呼用错，没通过检查不会自动放行。</span></div>
          <div className="field"><label>双语导出布局</label><select className="input" value={projectForm.value['export.bilingual_layout']} onChange={e => set('export.bilingual_layout', e.target.value as ProjectSettings['export.bilingual_layout'])}><option value="jp-top">日文在上</option><option value="zh-top">中文在上</option></select></div>
          <div className="field"><Switch checked={projectForm.value['export.translate_title']} onChange={v => set('export.translate_title', v)} label="导出时翻译书名和目录" /></div>
        </fieldset>}
        <BackupPanel />
        <div className="card"><h3>关于</h3><p className="small muted">北宇治译奏部 KitaUji Transpose · {APP_VERSION}<br />书库保存在本机的 library.sqlite 文件里。API 密钥用于向你配置的服务商验证身份；运行 AI 功能时，会发送相关原文与翻译上下文。</p></div>
        <div className="card"><h3 style={{ color: 'var(--status-error)' }}><AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 4 }} />危险操作</h3>
          <p className="small muted" style={{ marginTop: 0 }}>会删除全部书库内容，包括原文、译文、人物和术语；接口设置保留。请先保存还没提交的编辑。清空前必须成功备份，备份失败时会取消清空；成功提示会给出备份路径，可在上方“检查备份并恢复”中恢复。</p>
          <button className="btn btn-danger btn-sm" onClick={() => setResetOpen(true)}><Trash2 size={13} /> 清空全部数据</button>
        </div>
      </div></div></div>
      {resetOpen && <ConfirmDestructive title="清空全部数据" expected="清空" confirmLabel="清空全部数据" onClose={() => setResetOpen(false)} onConfirm={async () => {
        // 先把当前选择清掉，避免其他页面/副作用在清空瞬间用旧 id 查询
        useApp.setState({ currentSeriesId: null, currentVolumeId: null, currentChapterId: null, series: [], projectSettings: null, queueCount: 0 });
        isolateDrafts();
        const r = await api.app.resetLibrary();
        if (!r.ok) { toast('error', r.message); await refreshSeries(); return; }
        toast('success', r.message); await refreshSeries(); await refreshProvider(); await useApp.getState().refreshLogs();
        setResetOpen(false);
      }}>
        <p>会删除全部系列的所有数据，删除前会自动保存备份。请输入 <b>清空</b> 确认。</p></ConfirmDestructive>}
    </>
  );
}
