/**
 * The caricature character gallery: what each figurine wears. The storefront
 * shows a picture of each (tiny-tales-forus src/data/caricatureCharacters.ts,
 * same ids) and sends only the id; the words the image model is given live
 * here, so a browser cannot spend our OpenAI budget on a prompt of its own.
 */

export interface CaricatureCharacter {
  name: string
  /** Read into the preview prompt as "Costume: …". */
  costume: string
}

export const CARICATURE_CHARACTERS = {
  doctor: {
    name: 'Doctor',
    costume:
      'a doctor in a white coat over a shirt and tie, stethoscope round the neck, dark trousers, black shoes',
  },
  nurse: {
    name: 'Nurse',
    costume:
      "a hospital nurse's uniform: light blue tunic and trousers with white piping, a fob watch at the chest, white clogs",
  },
  lawyer: {
    name: 'Lawyer',
    costume:
      "an Indian advocate's court dress: black coat over a white shirt with white neck bands, black gown, black trousers and shoes",
  },
  police: {
    name: 'Police officer',
    costume:
      "an Indian police officer's khaki uniform with shoulder badges and a name plate, brown leather belt, black boots",
  },
  pilot: {
    name: 'Pilot',
    costume:
      "an airline pilot's uniform: white shirt with four gold stripes on the epaulettes, dark tie, gold wings badge, black trousers, holding a peaked cap",
  },
  chef: {
    name: 'Chef',
    costume:
      "a chef's whites: double-breasted white jacket, white neckerchief, apron, tall white chef's hat, hands on hips",
  },
  engineer: {
    name: 'Engineer',
    costume:
      'an orange high-visibility vest over a blue work shirt, jeans, safety boots, a white hard hat in one hand and a rolled drawing in the other',
  },
  teacher: {
    name: 'Teacher',
    costume:
      'a soft green cotton saree with a cardigan, holding a stack of books against the chest',
  },
  boss: {
    name: 'Boss',
    costume:
      'a charcoal two-piece business suit, white shirt, navy tie, a leather laptop bag in one hand, brown shoes',
  },
  groom: {
    name: 'Groom',
    costume:
      'a Punjabi wedding groom: royal blue and gold brocade sherwani over ivory, a red turban with a jewelled brooch, a sword at the side, embroidered jutti shoes',
  },
  bride: {
    name: 'Bride',
    costume:
      "an Indian bride's red lehenga with heavy gold embroidery, red dupatta over the shoulders, gold necklaces, bangles",
  },
  cricketer: {
    name: 'Cricketer',
    costume:
      'plain cricket whites with batting pads and gloves, holding a cricket bat, no team logos',
  },
  footballer: {
    name: 'Footballer',
    costume:
      'a plain green football kit with white trim, white shorts, green socks, boots, a football under one arm, no logos',
  },
  gym: {
    name: 'Gym',
    costume: 'a black sleeveless training vest, grey joggers, trainers, a dumbbell in each hand',
  },
  yoga: {
    name: 'Yoga',
    costume:
      'a plum fitted top and black yoga leggings, barefoot on a yoga mat, palms pressed together at the chest',
  },
  guitarist: {
    name: 'Guitarist',
    costume: 'a mustard kurta over blue jeans, brown sandals, playing an acoustic guitar',
  },
  dj: {
    name: 'DJ',
    costume:
      'a black t-shirt and black bomber jacket, dark jeans, white trainers, big headphones round the neck',
  },
  photographer: {
    name: 'Photographer',
    costume:
      'an olive jacket and dark trousers, a camera with a long lens held at the chest, a camera bag on one shoulder',
  },
  traveller: {
    name: 'Traveller',
    costume:
      'a red outdoor jacket, a big rucksack, cargo trousers, hiking boots, holding a folded map',
  },
  biker: {
    name: 'Biker',
    costume:
      'a plain black leather riding jacket, gloves, dark jeans, riding boots, a plain black helmet under one arm',
  },
  graduate: {
    name: 'Graduate',
    costume:
      'a black graduation gown with a coloured hood, holding a rolled diploma with a red ribbon',
  },
  diwali: {
    name: 'Diwali',
    costume:
      'a saffron silk kurta with an embroidered neckline, white churidar, mojari shoes, holding a lit clay diya',
  },
  maharaja: {
    name: 'Maharaja',
    costume:
      'royal attire: an ivory and gold brocade achkan, long pearl necklaces, a red sash, churidar, jutti shoes, a sword in its scabbard',
  },
  astronaut: {
    name: 'Astronaut',
    costume: 'a white spacesuit with patches on the chest and arms, gloves and boots',
  },
  hero: {
    name: 'Caped hero',
    costume:
      'our own caped hero: a teal bodysuit with mustard-yellow side panels, a short mustard cape, a silver belt, teal gloves and boots, no emblem',
  },
} as const satisfies Record<string, CaricatureCharacter>

export type CaricatureCharacterId = keyof typeof CARICATURE_CHARACTERS

export const CARICATURE_CHARACTER_IDS = Object.keys(CARICATURE_CHARACTERS) as [
  CaricatureCharacterId,
  ...CaricatureCharacterId[],
]
