<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  ChevronRight,
  File,
  Files,
  FileWarning,
  Folder,
  FolderOpen,
  GitBranch,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'
import PxIconButton from './PxIconButton.vue'
import { inferPreviewLanguageFromPath, renderSourceCodePreview } from '../lib/sourceCodePreview.js'

const props = defineProps({
  taskId: { type: String, required: true },
  workspaceCwd: { type: String, default: '' },
  isDark: { type: Boolean, default: false },
  mode: { type: String, default: 'files', validator: (value) => ['files', 'diff'].includes(value) },
})
const emit = defineEmits(['close'])

const directoryCache = ref({})
const expandedPaths = ref(new Set())
const directoryLoading = ref(new Set())
const selectedPath = ref('')
const filePreview = ref(null)
const filePreviewHtml = ref('')
const filePreviewObjectUrl = ref('')
const previewPane = ref(null)
const fileLoading = ref(false)
const requestedLine = ref(null)
const gitStatus = ref(null)
const gitLoading = ref(false)
const selectedDiffPath = ref('')
const displayedDiffPath = ref('')
const diff = ref(null)
const diffLoading = ref(false)
const error = ref('')
const showHiddenFiles = ref(false)
let workspaceVersion = 0

function clearFilePreviewObjectUrl() {
  if (filePreviewObjectUrl.value) URL.revokeObjectURL(filePreviewObjectUrl.value)
  filePreviewObjectUrl.value = ''
}

const visibleFiles = computed(() => {
  const result = []
  function append(directoryPath, depth) {
    for (const entry of directoryCache.value[directoryPath] || []) {
      if (!showHiddenFiles.value && entry.name.startsWith('.')) continue
      result.push({ ...entry, depth })
      if (entry.type === 'directory' && expandedPaths.value.has(entry.path)) append(entry.path, depth + 1)
    }
  }
  append('', 0)
  return result
})

const diffSections = computed(() => [
  ...(diff.value?.staged ? [{ key: 'staged', title: '已暂存', content: diff.value.staged }] : []),
  ...(diff.value?.unstaged ? [{ key: 'unstaged', title: '未暂存', content: diff.value.unstaged }] : []),
])
const drawerTitle = computed(() => props.workspaceCwd || (props.mode === 'files' ? '文件' : 'Diff'))

function diffLineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-delete'
  if (line.startsWith('@@')) return 'diff-hunk'
  return ''
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function statusLabel(status) {
  return ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' })[status] || 'M'
}

async function loadDirectory(directoryPath = '', force = false) {
  if (!props.taskId || directoryLoading.value.has(directoryPath)) return
  if (!force && directoryCache.value[directoryPath]) return
  const version = workspaceVersion
  directoryLoading.value = new Set(directoryLoading.value).add(directoryPath)
  try {
    const result = await v2Api.listTaskFiles(props.taskId, directoryPath)
    if (version !== workspaceVersion) return
    directoryCache.value = { ...directoryCache.value, [directoryPath]: result.directory.entries }
  } catch (cause) {
    if (version === workspaceVersion) error.value = cause.message
  } finally {
    const next = new Set(directoryLoading.value)
    next.delete(directoryPath)
    directoryLoading.value = next
  }
}

async function toggleDirectory(entry) {
  const next = new Set(expandedPaths.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else {
    next.add(entry.path)
    await loadDirectory(entry.path)
  }
  expandedPaths.value = next
}

async function renderFilePreview() {
  if (filePreview.value?.kind !== 'text') {
    filePreviewHtml.value = ''
    return
  }
  const currentPath = filePreview.value.path
  const rendered = await renderSourceCodePreview(filePreview.value.content, {
    language: inferPreviewLanguageFromPath(currentPath),
    isDark: props.isDark,
  })
  if (filePreview.value?.path !== currentPath) return
  filePreviewHtml.value = rendered.html
  await nextTick()
  if (requestedLine.value) {
    const pane = previewPane.value
    pane?.querySelectorAll('.is-target-line').forEach((element) => element.classList.remove('is-target-line'))
    const line = pane?.querySelector(`tr[data-preview-line="${requestedLine.value}"]`)
    line?.classList.add('is-target-line')
    if (pane && line) {
      const paneRect = pane.getBoundingClientRect()
      const lineRect = line.getBoundingClientRect()
      const headingHeight = pane.querySelector('.preview-heading')?.getBoundingClientRect().height || 0
      const visibleHeight = Math.max(0, pane.clientHeight - headingHeight)
      pane.scrollTop = Math.max(0, pane.scrollTop + lineRect.top - paneRect.top - headingHeight - (visibleHeight - lineRect.height) / 2)
    }
  }
}

async function selectFile(filePath, line = null) {
  selectedPath.value = filePath
  requestedLine.value = line
  fileLoading.value = true
  error.value = ''
  const version = workspaceVersion
  try {
    const result = await v2Api.readTaskFile(props.taskId, filePath)
    if (version !== workspaceVersion || selectedPath.value !== filePath) return
    const nextFile = result.file
    let nextObjectUrl = ''
    if (nextFile.kind === 'image') {
      const objectUrl = await v2Api.taskFileObjectUrl(props.taskId, nextFile.path)
      if (version !== workspaceVersion || selectedPath.value !== filePath) URL.revokeObjectURL(objectUrl)
      else nextObjectUrl = objectUrl
    }
    if (version !== workspaceVersion || selectedPath.value !== filePath) return
    const previousObjectUrl = filePreviewObjectUrl.value
    filePreview.value = nextFile
    if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl)
    filePreviewObjectUrl.value = nextObjectUrl
    await renderFilePreview()
  } catch (cause) {
    if (version === workspaceVersion) error.value = cause.message
  } finally {
    if (version === workspaceVersion && selectedPath.value === filePath) fileLoading.value = false
  }
}

async function selectTreeEntry(entry) {
  if (entry.type === 'directory') await toggleDirectory(entry)
  else await selectFile(entry.path)
}

async function loadGitStatus(options = {}) {
  if (!props.taskId || gitLoading.value) return
  gitLoading.value = true
  if (!options.quiet) error.value = ''
  const version = workspaceVersion
  try {
    const result = await v2Api.getTaskGitStatus(props.taskId)
    if (version !== workspaceVersion) return
    gitStatus.value = result.git
    if (selectedDiffPath.value && !result.git.files.some((file) => file.path === selectedDiffPath.value)) {
      selectedDiffPath.value = ''
      displayedDiffPath.value = ''
      diff.value = null
    }
  } catch (cause) {
    if (version === workspaceVersion && !options.quiet) error.value = cause.message
  } finally {
    if (version === workspaceVersion) gitLoading.value = false
  }
}

async function selectDiff(filePath) {
  selectedDiffPath.value = filePath
  diffLoading.value = true
  error.value = ''
  const version = workspaceVersion
  try {
    const result = await v2Api.getTaskGitDiff(props.taskId, filePath)
    if (version === workspaceVersion && selectedDiffPath.value === filePath) {
      diff.value = result.diff
      displayedDiffPath.value = filePath
    }
  } catch (cause) {
    if (version === workspaceVersion) error.value = cause.message
  } finally {
    if (version === workspaceVersion && selectedDiffPath.value === filePath) diffLoading.value = false
  }
}

async function expandParents(filePath) {
  const parts = filePath.split('/').filter(Boolean)
  let parent = ''
  for (const part of parts.slice(0, -1)) {
    parent = parent ? `${parent}/${part}` : part
    await loadDirectory(parent)
    expandedPaths.value = new Set(expandedPaths.value).add(parent)
  }
}

async function openPath(target) {
  if (!target?.path) return
  if (target.intent === 'diff') {
    await loadGitStatus({ quiet: true })
    await selectDiff(target.path)
    return
  }
  await loadDirectory('')
  await expandParents(target.path)
  await selectFile(target.path, target.line)
}

async function refreshGit(options = {}) {
  await loadGitStatus({ quiet: true })
  if (selectedDiffPath.value && !options.preserveDiff) await selectDiff(selectedDiffPath.value)
}

watch(() => props.taskId, async () => {
  workspaceVersion += 1
  clearFilePreviewObjectUrl()
  directoryCache.value = {}
  expandedPaths.value = new Set()
  selectedPath.value = ''
  filePreview.value = null
  gitStatus.value = null
  selectedDiffPath.value = ''
  displayedDiffPath.value = ''
  diff.value = null
  error.value = ''
  await Promise.all([loadDirectory(''), loadGitStatus({ quiet: true })])
}, { immediate: true })

watch(() => props.isDark, renderFilePreview)
watch(() => props.mode, (mode) => {
  error.value = ''
  if (mode === 'files') loadDirectory('')
  else loadGitStatus({ quiet: true })
})
onBeforeUnmount(() => {
  workspaceVersion += 1
  clearFilePreviewObjectUrl()
})
defineExpose({ openPath, refreshGit })
</script>

<template>
  <aside class="workspace-inspector relative flex min-h-0 min-w-0 flex-col">
    <header class="flex h-12 shrink-0 items-center border-b px-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <Files v-if="mode === 'files'" class="h-4 w-4 shrink-0" />
        <GitBranch v-else class="h-4 w-4 shrink-0" />
        <span class="truncate font-mono text-xs font-medium" :title="drawerTitle">{{ drawerTitle }}</span>
        <span v-if="mode === 'diff' && gitStatus?.files.length" class="tab-count">{{ gitStatus.files.length }}</span>
      </div>
      <div class="flex items-center gap-0.5">
        <PxIconButton v-if="mode === 'files'" class="drawer-action h-8 w-8" :class="!showHiddenFiles ? 'is-active' : ''" :label="showHiddenFiles ? '隐藏点文件' : '显示点文件'" :aria-pressed="!showHiddenFiles" @click="showHiddenFiles = !showHiddenFiles"><Eye v-if="showHiddenFiles" class="h-3.5 w-3.5" /><EyeOff v-else class="h-3.5 w-3.5" /></PxIconButton>
        <PxIconButton class="h-8 w-8" label="刷新" @click="mode === 'files' ? loadDirectory('', true) : loadGitStatus()"><RefreshCw class="h-3.5 w-3.5" :class="(directoryLoading.has('') || gitLoading) ? 'animate-spin' : ''" /></PxIconButton>
        <PxIconButton class="h-8 w-8" label="关闭抽屉" @click="emit('close')"><X class="h-4 w-4" /></PxIconButton>
      </div>
    </header>

    <div v-if="error" class="inspector-error shrink-0 border-b px-3 py-2 text-xs">{{ error }}</div>

    <div v-if="mode === 'files'" class="drawer-body grid min-h-0 flex-1">
      <div class="file-tree min-h-0 overflow-auto border-r py-1">
        <div v-if="directoryLoading.has('') && !directoryCache['']" class="inspector-skeleton p-2" role="status" aria-label="正在加载文件树">
          <div v-for="index in 8" :key="index" class="inspector-skeleton-line" :class="index % 3 === 0 ? 'is-short' : ''" />
        </div>
        <template v-else>
          <button
            v-for="entry in visibleFiles"
            :key="entry.path"
            type="button"
            class="tree-row flex h-7 min-h-0 w-full min-w-0 items-center justify-start gap-1.5 border-0 pr-2 text-left text-xs"
            :class="selectedPath === entry.path ? 'is-selected' : ''"
            :style="{ paddingLeft: `${8 + entry.depth * 14}px` }"
            :title="entry.path"
            @click="selectTreeEntry(entry)"
          >
            <ChevronRight v-if="entry.type === 'directory'" class="h-3 w-3 shrink-0 transition-transform" :class="expandedPaths.has(entry.path) ? 'rotate-90' : ''" />
            <span v-else class="w-3 shrink-0" />
            <FolderOpen v-if="entry.type === 'directory' && expandedPaths.has(entry.path)" class="folder-icon h-3.5 w-3.5 shrink-0" />
            <Folder v-else-if="entry.type === 'directory'" class="folder-icon h-3.5 w-3.5 shrink-0" />
            <Link2 v-else-if="entry.type === 'symlink'" class="theme-muted-text h-3.5 w-3.5 shrink-0" />
            <File v-else class="theme-muted-text h-3.5 w-3.5 shrink-0" />
            <span class="truncate">{{ entry.name }}</span>
            <LoaderCircle v-if="directoryLoading.has(entry.path)" class="theme-muted-text ml-auto h-3 w-3 shrink-0 animate-spin" />
          </button>
        </template>
        <div v-if="directoryCache[''] && !visibleFiles.length" class="theme-muted-text px-3 py-8 text-center text-xs">工作区为空</div>
      </div>

      <div ref="previewPane" class="preview-pane relative min-h-0 flex-1 overflow-auto">
        <div v-if="fileLoading && !filePreview" class="theme-muted-text flex h-full items-center justify-center"><LoaderCircle class="h-4 w-4 animate-spin" /></div>
        <div v-else-if="!filePreview" class="theme-muted-text flex h-full flex-col items-center justify-center p-5 text-center text-xs"><Files class="mb-2 h-6 w-6" />选择文件进行预览</div>
        <template v-else>
          <div class="preview-heading sticky top-0 z-[1] flex min-w-0 items-center justify-between gap-2 border-b px-3 py-2">
            <span class="truncate font-mono text-[11px]" :title="filePreview.path">{{ filePreview.path }}</span>
            <span class="theme-muted-text shrink-0 text-[10px]">{{ formatBytes(filePreview.size) }}</span>
          </div>
          <div v-if="filePreview.kind === 'text'" class="source-code-view" :style="{ '--source-code-gutter-width': '3.2rem' }">
            <table class="source-code-view__table"><tbody v-html="filePreviewHtml.replaceAll('data-line=', 'data-preview-line=')" /></table>
          </div>
          <div v-else-if="filePreview.kind === 'image'" class="flex min-h-full items-center justify-center p-4"><img v-if="filePreviewObjectUrl" class="max-h-full max-w-full object-contain" :src="filePreviewObjectUrl" :alt="filePreview.name" /></div>
          <div v-else class="theme-muted-text flex h-full flex-col items-center justify-center p-5 text-center text-xs"><component :is="filePreview.kind === 'too_large' ? FileWarning : ImageIcon" class="mb-2 h-6 w-6" />{{ filePreview.kind === 'too_large' ? '文件过大，暂不支持预览' : '二进制文件暂不支持预览' }}</div>
        </template>
        <div v-if="fileLoading && filePreview" class="inspector-loading-overlay" role="status" aria-label="正在加载文件预览"><LoaderCircle class="h-4 w-4 animate-spin" /></div>
      </div>
    </div>

    <div v-else class="drawer-body grid min-h-0 flex-1">
      <div class="changes-list min-h-0 overflow-auto border-r py-1">
        <div v-if="gitLoading && !gitStatus" class="inspector-skeleton p-2" role="status" aria-label="正在加载 Git 变更">
          <div v-for="index in 8" :key="index" class="inspector-skeleton-line" :class="index % 3 === 0 ? 'is-short' : ''" />
        </div>
        <div v-else-if="gitStatus && !gitStatus.available" class="theme-muted-text px-4 py-8 text-center text-xs">当前工作区不在 Git 仓库中</div>
        <div v-else-if="gitStatus && !gitStatus.files.length" class="theme-muted-text px-4 py-8 text-center text-xs">没有未提交的变更</div>
        <template v-else>
          <div v-if="gitStatus?.branch" class="theme-muted-text flex h-7 items-center gap-1.5 px-3 text-[10px]"><GitBranch class="h-3 w-3" />{{ gitStatus.branch }}</div>
          <button v-for="file in gitStatus?.files" :key="file.path" type="button" class="change-row flex h-8 min-h-0 w-full min-w-0 items-center justify-start gap-2 border-0 px-3 text-left text-xs" :class="selectedDiffPath === file.path ? 'is-selected' : ''" :title="file.path" @click="selectDiff(file.path)">
            <span class="change-status w-4 shrink-0 text-center font-mono text-[10px]" :data-status="file.status">{{ statusLabel(file.status) }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ file.path }}</span>
            <span v-if="file.staged" class="theme-muted-text shrink-0 text-[9px]">S</span>
          </button>
        </template>
      </div>

      <div class="diff-pane relative min-h-0 flex-1 overflow-auto">
        <div v-if="!selectedDiffPath" class="theme-muted-text flex h-full flex-col items-center justify-center p-5 text-center text-xs"><GitBranch class="mb-2 h-6 w-6" />选择文件查看 Diff</div>
        <template v-else>
          <div class="preview-heading sticky top-0 z-[1] border-b px-3 py-2 font-mono text-[11px]">{{ displayedDiffPath || selectedDiffPath }}</div>
          <div v-if="diff?.truncated" class="inspector-warning border-b px-3 py-2 text-[10px]">Diff 过大，仅显示前 2 MB 或 8000 行</div>
          <div v-if="diff && !diffSections.length" class="theme-muted-text px-4 py-8 text-center text-xs">没有可显示的文本 Diff</div>
          <section v-for="section in diffSections" :key="section.key">
            <div class="diff-section-title sticky top-[33px] z-[1] border-b px-3 py-1.5 text-[10px] font-medium">{{ section.title }}</div>
            <pre class="diff-code m-0 min-w-max"><code><span v-for="(line, index) in section.content.split('\n')" :key="index" class="diff-line block px-3" :class="diffLineClass(line)">{{ line || ' ' }}</span></code></pre>
          </section>
        </template>
        <div v-if="diffLoading" class="inspector-loading-overlay" role="status" aria-label="正在加载 Diff"><LoaderCircle class="h-4 w-4 animate-spin" /></div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.workspace-inspector { background: var(--theme-appPanel); border-color: var(--theme-borderDefault); box-shadow: var(--theme-shadowPanel); }
.workspace-inspector header, .file-tree, .changes-list, .preview-heading, .diff-section-title { border-color: var(--theme-borderDefault); }
.inspector-skeleton { display: grid; gap: 0.5rem; }
.inspector-skeleton-line { height: 1.75rem; border-radius: 2px; background: var(--theme-appPanelInset); opacity: 0.7; animation: inspector-skeleton-pulse 1.2s ease-in-out infinite; }
.inspector-skeleton-line.is-short { width: 68%; }
.inspector-loading-overlay { position: absolute; inset: 0; z-index: 5; display: flex; align-items: flex-start; justify-content: center; padding-top: 4rem; background: color-mix(in srgb, var(--theme-appPanel) 82%, transparent); color: var(--theme-textMuted); }
@keyframes inspector-skeleton-pulse { 0%, 100% { opacity: 0.42; } 50% { opacity: 0.82; } }
.drawer-action.is-active { background: var(--theme-accentSoft); color: var(--theme-accentText); }
.drawer-body { grid-template-columns: minmax(240px, 30%) minmax(0, 1fr); }
.tab-count { min-width: 1rem; border-radius: 999px; background: var(--theme-appPanelStrong); padding: 0 0.3rem; text-align: center; font-size: 9px; }
.tree-row, .change-row { transition: background-color 140ms ease, color 140ms ease; }
.tree-row:hover, .change-row:hover { background: var(--theme-appPanelHover); }
.tree-row.is-selected, .change-row.is-selected { background: var(--theme-appPanelActive); }
.folder-icon { color: var(--theme-warningText); }
.preview-heading, .diff-section-title { background: var(--theme-appPanelStrong); }
.inspector-error { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.inspector-warning { border-color: var(--theme-warning); background: var(--theme-warningSoft); color: var(--theme-warningText); }
.source-code-view { min-width: max-content; }
.source-code-view__table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; color: inherit; font-family: var(--theme-fontMono); font-size: 11px; line-height: 1.6; }
.source-code-view :deep(.source-code-view__gutter) { width: var(--source-code-gutter-width); min-width: var(--source-code-gutter-width); border-right: 1px solid var(--theme-borderMuted); padding: 0 0.4rem; color: var(--theme-textMuted); text-align: right; vertical-align: top; user-select: none; }
.source-code-view :deep(.source-code-view__code) { padding: 0 0.75rem; vertical-align: top; white-space: pre; }
.source-code-view :deep(.source-code-view__line-inner) { display: block; min-height: 1.45em; }
.source-code-view :deep(.source-code-view__line:hover) { background: var(--theme-appPanelHover); }
.source-code-view :deep(.source-code-view__line.is-target-line) { background: var(--theme-infoSoft); }
.source-code-view :deep([data-preview-line]) { scroll-margin-block: 4rem; }
.diff-code { font-family: var(--theme-fontMono); font-size: 10px; line-height: 1.55; }
.diff-line { min-height: 1.55em; }
.diff-add { background: var(--theme-successSoft); color: var(--theme-successText); }
.diff-delete { background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.diff-hunk { background: var(--theme-infoSoft); color: var(--theme-infoText); }
.diff-meta { color: var(--theme-textMuted); }
.change-status[data-status='added'], .change-status[data-status='untracked'] { color: var(--theme-successText); }
.change-status[data-status='deleted'], .change-status[data-status='conflicted'] { color: var(--theme-dangerText); }
.change-status[data-status='renamed'] { color: var(--theme-infoText); }
.change-status[data-status='modified'] { color: var(--theme-warningText); }
@media (prefers-reduced-motion: reduce) {
  .drawer-action, .tree-row, .change-row { transition: none; }
  .inspector-skeleton-line { animation: none; opacity: 0.62; }
}
@media (max-width: 720px) {
  .drawer-body { grid-template-columns: minmax(180px, 38%) minmax(0, 1fr); }
}
</style>
