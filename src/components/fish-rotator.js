// Composant pour faire tourner les modèles de poisson affichés dans le panneau BONUS
AFRAME.registerComponent('fish-rotator', {
  schema: { interval: { type: 'number', default: 10000 } },

  init: function () {
    var config = window.GAME_CONFIG || {};
    this.fishModels = config.BONUS_FISH_MODELS || [
      { type: 'goldfish', model: '#goldfish', position: '0.05 0.02 0', rotation: '0 90 0', scale: '0.004 0.004 0.004' },
      { type: 'piranha', model: '#piranha', position: '0 -0.02 0', rotation: '0 90 0', scale: '0.008 0.008 0.008' },
      { type: 'thon', model: '#thon', position: '0 0 0', rotation: '0 90 0', scale: '0.006 0.006 0.006' },
      { type: 'thon_bleu', model: '#thon_bleu', position: '0 0 0', rotation: '0 90 0', scale: '0.012 0.012 0.012' }
    ];
    this.currentIndex = 0;
    var self = this;
    if (this.el.sceneEl.hasLoaded) this.startRotation(); else this.el.sceneEl.addEventListener('loaded', function () { self.startRotation(); });
  },

  startRotation: function () {
    var self = this;
    // Boucle GSAP : appeler nextFish régulièrement
    this._rotationCall = gsap.delayedCall(this.data.interval / 1000, function repeat() {
      self.nextFish();
      self._rotationCall = gsap.delayedCall(self.data.interval / 1000, repeat);
    });
    this.applyCurrent();
  },

  getCurrentFish: function () { return this.fishModels[this.currentIndex].type; },
  getCurrentFishModel: function () { return this.fishModels[this.currentIndex].model; },

  applyCurrent: function () {
    var d = this.fishModels[this.currentIndex];
    var el = this.el;
    el.removeAttribute('gltf-model');
    // Petit délai GSAP avant d'appliquer le nouveau modèle
    gsap.delayedCall(0.05, function () {
      el.setAttribute('gltf-model', d.model);
      el.setAttribute('position', d.position);
      el.setAttribute('rotation', d.rotation);
      el.setAttribute('scale', d.scale);
    });
  },

  nextFish: function () {
    this.currentIndex = (this.currentIndex + 1) % this.fishModels.length;
    this.applyCurrent();
  },

  remove: function () {
    if (this._rotationCall) this._rotationCall.kill();
  }
});
