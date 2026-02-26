AFRAME.registerComponent('water-shader', {
  schema: {
    color: { type: 'color', default: '#0077be' },
    opacity: { type: 'number', default: 0.6 },
    speed: { type: 'number', default: 1.0 },
    waveHeight: { type: 'number', default: 0.1 },
    waveFrequency: { type: 'number', default: 2.0 },
    width: { type: 'number', default: 10 },
    depth: { type: 'number', default: 10 }
  },

  init: function () {
    var data = this.data;
    var el = this.el;

    var geometry = new THREE.PlaneGeometry(data.width, data.depth, 64, 64);

    var material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(data.color),
      transparent: true,
      opacity: data.opacity,
      side: THREE.DoubleSide,
      metalness: 0.1,
      roughness: 0.3
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.rotation.x = -Math.PI / 2;
    el.setObject3D('mesh', this.mesh);

    this.originalPositions = geometry.attributes.position.array.slice();
    this.time = 0;
  },

  tick: function (time, deltaTime) {
    if (!this.mesh) return;

    var data = this.data;
    this.time += deltaTime * 0.001 * data.speed;

    var positions = this.mesh.geometry.attributes.position.array;
    var original = this.originalPositions;

    for (var i = 0; i < positions.length; i += 3) {
      var x = original[i];
      var y = original[i + 1];
      var wave1 = Math.sin(x * data.waveFrequency + this.time) * data.waveHeight;
      var wave2 = Math.sin(y * data.waveFrequency * 0.8 + this.time * 1.2) * data.waveHeight * 0.5;
      var wave3 = Math.sin((x + y) * data.waveFrequency * 0.5 + this.time * 0.8) * data.waveHeight * 0.3;
      positions[i + 2] = wave1 + wave2 + wave3;
    }

    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  },

  update: function (oldData) {
    if (this.mesh && (oldData.width !== this.data.width || oldData.depth !== this.data.depth)) {
      this.mesh.geometry.dispose();
      var geometry = new THREE.PlaneGeometry(this.data.width, this.data.depth, 64, 64);
      this.mesh.geometry = geometry;
      this.originalPositions = geometry.attributes.position.array.slice();
    }
  }
});
