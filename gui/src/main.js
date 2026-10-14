import { createApp } from 'vue'

import App from '@/App.vue'
import router from '@/router'
import vuetify from '@/plugins/vuetify'
import '@/styles/app.css'
import { loadIdentity } from '@/identity'

// Asked before the first render, so a verified proxy login never sees the token page flash.
loadIdentity().finally(() => createApp(App)
  .use(router)
  .use(vuetify)
  .mount('#app'))
