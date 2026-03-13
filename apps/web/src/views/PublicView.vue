<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  Clock3,
  Copy,
  FileText,
  Image as ImageIcon,
  SquarePen,
} from 'lucide-vue-next'
import { useRoute } from 'vue-router'
import TopToast from '../components/TopToast.vue'
import { useToast } from '../composables/useToast.js'
import { getApiBase, getDocument, resolveAssetUrl } from '../lib/api.js'
import { buildCodexPrompt } from '../lib/codex.js'

const route = useRoute()
const slug = computed(() => route.params.slug)
const document = ref(null)
const error = ref('')
const loading = ref(true)
const rawUrl = computed(() => `${getApiBase()}/p/${slug.value}/raw`)
const collapsedMap = ref({})
const { toastMessage, flashToast } = useToast()
let loadRequestId = 0

function syncCollapsedState(blocks = []) {
  collapsedMap.value = Object.fromEntries(
    blocks.map((block, index) => [index, block.type === 'imported_text' ? block.meta?.collapsed !== false : false])
  )
}

async function loadDocument() {
  const requestId = ++loadRequestId
  loading.value = true
  error.value = ''
  try {
    const payload = await getDocument(slug.value)
    if (requestId !== loadRequestId) {
      return
    }
    document.value = {
      ...payload,
      blocks: payload.blocks.map((block) => ({
        ...block,
        content: block.type === 'image' ? resolveAssetUrl(block.content) : block.content,
      })),
    }
    syncCollapsedState(document.value.blocks)
  } catch (err) {
    if (requestId !== loadRequestId) {
      return
    }
    error.value = err.message
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false
    }
  }
}

function toggleImportedCollapse(index) {
  collapsedMap.value[index] = !collapsedMap.value[index]
}

function getImportedPreview(content = '', max = 180) {
  const compact = String(content).replace(/\s+/g, ' ').trim()
  return compact.slice(0, max)
}

function getImportedStats(content = '') {
  const text = String(content)
  const lines = text ? text.split('\n').length : 0
  const chars = text.length
  return `${lines} 行 · ${chars} 字`
}

async function copyCodexPrompt() {
  await navigator.clipboard.writeText(buildCurrentCodexPrompt())
  flashToast('已复制给 Codex')
}

function buildCurrentCodexPrompt() {
  if (!document.value) {
    return ''
  }
  return buildCodexPrompt(document.value, rawUrl.value)
}

onMounted(loadDocument)

watch(slug, () => {
  loadDocument()
})
</script>

<template>
  <div class="w-full">
    <TopToast :message="toastMessage" />

    <section v-if="loading" class="panel p-5 text-sm text-stone-600 dark:text-stone-400">正在加载页面...</section>
    <section v-else-if="error" class="panel p-5 text-sm text-red-700 dark:text-red-300">{{ error }}</section>

    <template v-else>
      <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <RouterLink to="/" class="inline-flex items-center gap-2 text-sm text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100">
          <ArrowLeft class="h-4 w-4" />
          <span>返回首页</span>
        </RouterLink>
        <div class="flex flex-wrap gap-2">
          <RouterLink :to="`/edit/${slug}`" class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs">
            <SquarePen class="h-4 w-4" />
            <span>编辑</span>
          </RouterLink>
          <button type="button" class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs" @click="copyCodexPrompt">
            <Copy class="h-4 w-4" />
            <span>复制给 Codex</span>
          </button>
          <a :href="rawUrl" class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs">
            <FileText class="h-4 w-4" />
            <span>Raw 文本</span>
          </a>
        </div>
      </header>

      <article class="px-1 py-2 sm:px-2">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 class="text-2xl font-semibold">{{ document.displayTitle || document.title || '未命名文档' }}</h1>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
          <span class="inline-flex items-center gap-1">
            <Clock3 class="h-3.5 w-3.5" />
            <span>{{ new Date(document.updatedAt).toLocaleString('zh-CN') }}</span>
          </span>
          <span v-if="document.expiresAt" class="inline-flex items-center"> · {{ new Date(document.expiresAt).toLocaleString('zh-CN') }} 过期</span>
        </div>

        <section v-if="!document.blocks.length" class="mt-6 text-sm text-stone-600 dark:text-stone-400">
          这个文档还没有内容。
        </section>

        <div v-for="(block, index) in document.blocks" :key="`${block.type}-${index}`" class="mt-6">
          <div v-if="block.type === 'text'" class="prose-like whitespace-pre-wrap text-[15px] leading-8 text-stone-800 dark:text-stone-200">
            {{ block.content }}
          </div>
          <div v-else-if="block.type === 'imported_text'" class="dashed-panel overflow-hidden">
            <div class="flex items-center justify-between gap-3 border-b border-dashed border-stone-300 px-4 py-3 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-400">
              <div class="min-w-0">
                <p>导入文件<span v-if="block.meta?.fileName"> · {{ block.meta.fileName }}</span></p>
                <p class="mt-1">{{ getImportedStats(block.content) }}</p>
              </div>
              <button type="button" class="tool-button px-2 py-1 text-xs" @click="toggleImportedCollapse(index)">
                {{ collapsedMap[index] ? '展开' : '收起' }}
              </button>
            </div>
            <div v-if="collapsedMap[index]" class="px-4 py-4 text-sm leading-7 text-stone-600 dark:text-stone-300">
              {{ getImportedPreview(block.content) || '空内容' }}<span v-if="block.content.length > 180">...</span>
            </div>
            <div v-else class="whitespace-pre-wrap px-4 py-4 text-[15px] leading-8 text-stone-800 dark:text-stone-200">
              {{ block.content }}
            </div>
          </div>
          <div v-else class="overflow-hidden rounded-sm bg-stone-100 dark:bg-stone-900">
            <div class="flex items-center gap-2 border-b border-stone-200 px-4 py-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
              <ImageIcon class="h-4 w-4" />
              <span>图片内容</span>
            </div>
            <img :src="block.content" alt="上传图片" class="w-full object-contain" />
          </div>
        </div>
      </article>
    </template>
  </div>
</template>
