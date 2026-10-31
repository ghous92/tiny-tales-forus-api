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

/** No costume: the figurine keeps the clothes and pose in the shopper's photo. */
export const AS_PHOTO_ID = 'as-photo'

export const CARICATURE_CHARACTERS = {
  [AS_PHOTO_ID]: {
    name: 'As in the photo',
    costume: 'the clothes they wear in the photo',
  },
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
      'a loose plum t-shirt and black track pants, barefoot on a yoga mat, palms pressed together at the chest',
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
      'our own caped hero: a teal full-body costume with mustard-yellow side panels, a short mustard cape, a silver belt, teal gloves and boots, no emblem',
  },
  spiderman: {
    name: 'Spider-Man',
    costume:
      'a loose-fitting red and black superhero costume with a web pattern, long sleeves and full-length legs, a small spider emblem on the chest, red boots, no mask so the face shows',
  },
  ironman: {
    name: 'Iron Man',
    costume:
      'a red and gold powered armour suit with a glowing round light in the chest, gauntlets and boots, helmet off so the face is bare',
  },
  'captain-america': {
    name: 'Captain America',
    costume:
      'a blue suit with a white star on the chest and red and white stripes at the waist, red gloves and boots, a round red, white and blue shield on one arm, no mask',
  },
  thor: {
    name: 'Thor',
    costume:
      'a Norse warrior outfit: a black leather armour vest with round blue studs, arm guards, black trousers and boots, a long red cape, a war hammer in one hand',
  },
  'she-hulk': {
    name: 'She-Hulk',
    costume: 'a white and purple t-shirt over lilac jeans, black boots, green arms and hands',
  },
  'black-widow': {
    name: 'Black Widow',
    costume:
      'a black long-sleeved tactical jumpsuit with a front zip, a gold belt of linked discs, gold wrist bracers, black boots',
  },
  'black-panther': {
    name: 'Black Panther',
    costume:
      'a black armoured suit with purple glowing seams, clawed gloves and boots, a panther cowl pushed back so the face shows',
  },
  'doctor-strange': {
    name: 'Doctor Strange',
    costume:
      'a blue tunic with a black belt, a glowing green amulet at the chest, a long red cloak with a high collar, dark trousers and boots',
  },
  wolverine: {
    name: 'Wolverine',
    costume:
      'a yellow and blue full-body costume with black stripes down the sides and a black belt, black gloves and boots, three steel claws from each fist, cowl pushed back',
  },
  deadpool: {
    name: 'Deadpool',
    costume:
      'a red and black full-body costume with a utility harness, twin sword hilts across the back, belts with pouches, black boots, mask off',
  },
  'captain-marvel': {
    name: 'Captain Marvel',
    costume:
      'a blue and red flight suit with a gold star on the chest, red gloves and boots, a red sash at the waist',
  },
  'scarlet-witch': {
    name: 'Scarlet Witch',
    costume:
      'a long red leather coat with a high collar over black leather trousers, black boots and gloves, a red glow around one hand',
  },
  loki: {
    name: 'Loki',
    costume:
      'a green and black leather tunic with gold trim, a long green cape, a golden horned helmet, a golden sceptre in one hand',
  },
  'star-lord': {
    name: 'Star-Lord',
    costume:
      'a long maroon leather coat over a grey t-shirt, brown trousers and boots, twin pistols at the belt',
  },
  venom: {
    name: 'Venom',
    costume:
      'a black full-body superhero costume with a large white spider shape across the chest, clawed hands',
  },
  storm: {
    name: 'Storm',
    costume:
      'a black long-sleeved jumpsuit, a long black cape lined in gold, a tall black headpiece, black boots with gold bands',
  },
  batman: {
    name: 'Batman',
    costume:
      'a black bat-themed suit with a bat emblem on the chest, a gold utility belt, a long black cape, the cowl pushed back so the face shows',
  },
  superman: {
    name: 'Superman',
    costume:
      'a blue full-body costume with a red cape, red boots and a large shield-shaped emblem on the chest, no mask',
  },
  'wonder-woman': {
    name: 'Wonder Woman',
    costume:
      'a red armoured tunic with a golden eagle on the chest, a knee-length blue star-spangled skirt, red and white boots, silver bracers, a flowing blue and red cape, a golden lasso at the hip',
  },
  flash: {
    name: 'The Flash',
    costume:
      'a red full-body costume with gold lightning-bolt trim and belt, a lightning emblem on the chest, red gloves and boots, cowl off',
  },
  aquaman: {
    name: 'Aquaman',
    costume:
      'orange and green scaled armour, gold arm guards, green trousers, a golden trident held in one hand',
  },
  'green-lantern': {
    name: 'Green Lantern',
    costume:
      'a green and black full-body costume with a round green lantern emblem on the chest, white gloves, a green power ring',
  },
  robin: {
    name: 'Robin',
    costume:
      'a red vest with a letter R, green gloves, olive trousers, a yellow and black cape, a utility belt, boots, no mask',
  },
  supergirl: {
    name: 'Supergirl',
    costume:
      'a blue top with a shield-shaped emblem, a red pleated skirt, a red cape, red boots, blue gloves and a gold belt',
  },
  batgirl: {
    name: 'Batgirl',
    costume:
      'a purple full-body costume with a yellow bat emblem on the chest, a yellow utility belt, a long yellow-lined cape, no mask',
  },
  'harley-quinn': {
    name: 'Harley Quinn',
    costume:
      'a loose red and black diamond-patterned jester costume with long sleeves, white ruffled cuffs and collar, red boots, a giant red and black mallet',
  },
  joker: {
    name: 'Joker',
    costume:
      'a purple long coat over a green waistcoat and shirt, a yellow flower on the lapel, purple trousers, white shoes, a big mallet',
  },
  catwoman: {
    name: 'Catwoman',
    costume:
      'a black long-sleeved jumpsuit with silver stitching, a black belt, black gloves and boots',
  },
  shazam: {
    name: 'Shazam',
    costume:
      'a red full-body costume with a gold lightning bolt on the chest, a white cape with gold trim, gold wrist guards and boots',
  },
  'green-arrow': {
    name: 'Green Arrow',
    costume:
      'a green hooded leather outfit with a striped tunic, fingerless gloves, a quiver and boots',
  },
} as const satisfies Record<string, CaricatureCharacter>

export type CaricatureCharacterId = keyof typeof CARICATURE_CHARACTERS

export const CARICATURE_CHARACTER_IDS = Object.keys(CARICATURE_CHARACTERS) as [
  CaricatureCharacterId,
  ...CaricatureCharacterId[],
]
