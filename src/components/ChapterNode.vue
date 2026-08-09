<script setup>
import { ref } from 'vue'

defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  indexMap: { type: Object, default: () => ({}) },
  activeId: { type: String, default: '' },
})
const emit = defineEmits(['select'])

const open = ref(true)
</script>

<template>
  <div class="cnode">
    <div
      v-if="node.children && node.children.length"
      class="cnode-chapter"
      :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
      @click="open = !open"
    >
      <span class="toggle">{{ open ? '▼' : '▶' }}</span>
      <span class="cnode-title">{{ node.title }}</span>
    </div>
    <div v-if="node.children && node.children.length && open" class="cnode-children">
      <ChapterNode
        v-for="c in node.children"
        :key="c.title"
        :node="c"
        :depth="depth + 1"
        :index-map="indexMap"
        :active-id="activeId"
        @select="emit('select', $event)"
      />
    </div>
    <div
      v-for="ep in node.episodes"
      :key="ep.episodeId"
      class="cnode-episode"
      :class="{ active: ep.episodeId === activeId }"
      :style="{ paddingLeft: depth * 14 + 22 + 'px' }"
      @click="emit('select', ep)"
    >
      <span class="cnode-idx">[{{ indexMap[ep.episodeId] }}]</span>
      {{ ep.title }}
    </div>
  </div>
</template>

<style scoped>
.cnode { font-size: 13px; }
.cnode-chapter {
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
  font-weight: 600;
  color: var(--font-gold, #fed57f);
  user-select: none;
}
.cnode-chapter:hover { background: rgba(130, 178, 69, 0.12); }
.toggle { margin-right: 6px; font-size: 11px; color: var(--font-light-gray, #747780); }
.cnode-episode {
  padding: 5px 8px;
  cursor: pointer;
  border-radius: 4px;
  border-left: 2px solid transparent;
  color: var(--blank-white, #ede5d8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}
.cnode-episode:hover { background: rgba(130, 178, 69, 0.12); }
.cnode-episode.active {
  background: rgba(130, 178, 69, 0.2);
  border-left-color: var(--selected-border, #82b245);
  color: #fff;
}
.cnode-idx { color: var(--font-light-gray, #747780); margin-right: 6px; font-size: 11px; }
</style>
