import type { IdeaCategory } from './types'

/** Kinds of game ideas the user can ask for: the label shown, a one-line hint, and how Claude should approach it. */
export const IDEA_CATEGORIES: { id: IdeaCategory; label: string; hint: string; guide: string }[] = [
  {
    id: 'trend',
    label: 'Trend twist',
    hint: "A fresh take on what's hot right now",
    guide: "Ride a trending game's genre, loop or social hook with a clear twist of your own. Prefer less crowded spaces. List the trending names it rides in inspiredBy."
  },
  {
    id: 'original',
    label: 'Original',
    hint: 'Brand-new concepts, not versions of popular games',
    guide: 'Invent concepts that are NOT versions of any trending game: a new premise, world or core mechanic. Use the data only to avoid crowded spaces. Leave inspiredBy empty.'
  },
  {
    id: 'niche',
    label: 'Untapped niche',
    hint: 'Spaces with players but few good games',
    guide: 'Target game spaces with real demand but low saturation, few games or old leaders. Say which gap it fills.'
  },
  {
    id: 'mashup',
    label: 'Genre mash-up',
    hint: 'Two genres combined into something new',
    guide: 'Combine two different genres or loops into one game that feels new. Name both genres in the pitch.'
  },
  {
    id: 'experimental',
    label: 'Experimental',
    hint: 'Unusual mechanics and social play',
    guide: 'Unusual mechanics: social deduction, creative building, physics, asymmetric or cooperative puzzles. Novel, but fun within a minute.'
  }
]

export function ideaCategory(id: string | undefined): (typeof IDEA_CATEGORIES)[number] {
  return IDEA_CATEGORIES.find((c) => c.id === id) ?? IDEA_CATEGORIES[0]!
}
