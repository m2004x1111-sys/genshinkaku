import { createApp } from 'vue'
import GenshinUI from '@shi-zhong/genshin-ui'
import '@shi-zhong/genshin-ui/css'
import App from './App.vue'
import './style.css'

const app = createApp(App)
app.use(GenshinUI)
app.mount('#app')
