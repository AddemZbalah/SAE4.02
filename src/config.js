// Configuration globale du jeu

window.GAME_CONFIG = {

  // Modèles de poissons disponibles
  FISH_MODELS: [
    { type: 'goldfish', model: '#goldfish', scaleAdjust: 0.5 },
    { type: 'piranha', model: '#piranha', scaleAdjust: 4.0 },
    { type: 'thon', model: '#thon', scaleAdjust: 0.5 },
    { type: 'thon_bleu', model: '#thon_bleu', scaleAdjust: 4.0 }
  ],

  // Modèles affichés dans le panneau bonus
  BONUS_FISH_MODELS: [
    { type: 'goldfish', model: '#goldfish', position: '0.05 0.02 0', rotation: '0 90 0', scale: '0.004 0.004 0.004' },
    { type: 'piranha', model: '#piranha', position: '0 -0.02 0', rotation: '0 90 0', scale: '0.008 0.008 0.008' },
    { type: 'thon', model: '#thon', position: '0 0 0', rotation: '0 90 0', scale: '0.006 0.006 0.006' },
    { type: 'thon_bleu', model: '#thon_bleu', position: '0 0 0', rotation: '0 90 0', scale: '0.012 0.012 0.012' }
  ],

  // Scoring
  POINTS_CORRECT_FISH: 10,   // Points gagnés pour le bon poisson
  POINTS_WRONG_FISH: -5,     // Points perdus pour un mauvais poisson

  // Timer
  GAME_DURATION: 60,         // Durée d'une partie en secondes

  // Pièce par défaut (sans scan XR)
  DEFAULT_ROOM: {
    centerX: 0,
    centerZ: -2,
    width: 4,
    depth: 4,
    height: 2.5,
    floorY: 0,
    bounds: { minX: -2, maxX: 2, minZ: -3, maxZ: 1 }
  },

  // Noms affichés par type de poisson
  FISH_DISPLAY_NAMES: {
    goldfish: '🐟 Goldfish',
    piranha: '🐠 Piranha',
    thon: '🐟 Thon',
    thon_bleu: '🐟 Thon Bleu',
    unknown: '🐟 Poisson'
  }
};
