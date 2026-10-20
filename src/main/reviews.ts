import { randomUUID } from 'node:crypto'
import type { Review } from '@shared/types'
import { JsonStore } from './jsonStore'

/** Finished autonomous tasks waiting for (or done with) your review. */
export class ReviewStore {
  private store: JsonStore<{ reviews: Review[] }>

  constructor(
    file: string,
    private readonly onPrune: (r: Review) => void = () => {}
  ) {
    this.store = new JsonStore(file, { reviews: [] as Review[] })
  }

  list(projectId?: string): Review[] {
    const all = this.store.get().reviews
    return (projectId ? all.filter((r) => r.projectId === projectId) : all).slice().sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Review {
    const r = this.store.get().reviews.find((x) => x.id === id)
    if (!r) throw new Error('Review not found.')
    return r
  }

  add(fields: Omit<Review, 'id' | 'createdAt' | 'status' | 'clip' | 'published'> & Partial<Pick<Review, 'clip'>>): Review {
    const review: Review = { clip: null, published: null, ...fields, id: randomUUID(), createdAt: Date.now(), status: 'pending' }
    // Keep the newest 200 reviews per store; old decided ones are dropped first.
    const pruned: Review[] = []
    this.store.update((s) => {
      const reviews = [...s.reviews, review]
      const decided = reviews.filter((r) => r.status !== 'pending').sort((a, b) => a.createdAt - b.createdAt)
      while (reviews.length > 200 && decided.length) {
        const old = decided.shift()!
        reviews.splice(reviews.indexOf(old), 1)
        pruned.push(old)
      }
      return { reviews }
    })
    for (const r of pruned) this.onPrune(r)
    return review
  }

  update(id: string, patch: Partial<Review>): Review {
    let out: Review | null = null
    this.store.update((s) => ({
      reviews: s.reviews.map((r) => {
        if (r.id !== id) return r
        out = { ...r, ...patch, id: r.id }
        return out
      })
    }))
    if (!out) throw new Error('Review not found.')
    return out
  }
}
