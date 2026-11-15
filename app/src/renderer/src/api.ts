import type { DragonApi } from '@shared/types'

export type Api = DragonApi

declare global {
  interface Window {
    dragon: Api
  }
}

export const api: Api = window.dragon
