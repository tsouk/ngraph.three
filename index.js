const THREE = require('three');
const delaunator = require('delaunator');
const circumradius = require('circumradius');
const _ = require('lodash');
const DEL_THROTTLE = 500;
const ALPHA = 20;
const HEIGHT_STEP = 15;
const consoleThrottled = _.throttle(console.log, DEL_THROTTLE);

module.exports = function (graph, settings, maxParticleCount, maxDepth) {
  const merge = require('ngraph.merge');
  settings = merge(settings, {
    interactive: true
  });

  var beforeFrameRender;
  var isStable = false;
  var disposed = false;
  var layout = createLayout(settings);
  var renderer = createRenderer(settings);
  var camera = createCamera(settings);
  var scene = settings.scene || new THREE.Scene();

  // -------- Delaunay ---------
  let delaunay;
  let throttledDelaunatorTriangles = _.throttle(getDelaunayTriangles, DEL_THROTTLE);
  let nodeArray = [];
  let triangles = [];

  // -------- Particles ----------
  var group;
  var pointCloud;
  var particlesData = [];
  var particlePositions;
  var linesMesh;
  var positions, colors;
  var particles;
  var normalsComputed = false;
  var r = 800;
  var rHalf = r / 2;

  // -------------------------------------------------------
  var nodeUI; // Storage for UI of nodes/links
  var controls = {
    update: function noop() {}
  };

  var graphics = {
    THREE: THREE, // expose THREE so that clients will not have to require it twice.
    run: run,
    renderOneFrame: renderOneFrame,

    onFrame: onFrame,

    /**
     * Gets UI object for a given node id
     */
    getNodeUI: function (nodeId) {
      return nodeUI[nodeId];
    },

    getLinkUI: function (linkId) {
      return linkUI[linkId];
    },

    /**
     * This callback creates new UI for a graph node. This becomes helpful
     * when you want to precalculate some properties, which otherwise could be
     * expensive during rendering frame.
     *
     * @callback createNodeUICallback
     * @param {object} node - graph node for which UI is required.
     * @returns {object} arbitrary object which will be later passed to renderNode
     */
    /**
     * This function allows clients to pass custom node UI creation callback
     *
     * @param {createNodeUICallback} createNodeUICallback - The callback that
     * creates new node UI
     * @returns {object} this for chaining.
     */
    createNodeUI: function (createNodeUICallback) {
      //nodeUIBuilder = createNodeUICallback;
      rebuildUI();
      return this;
    },


    /**
     * Force a rebuild of the UI. This might be necessary after settings have changed
     */
    rebuild: function () {
      rebuildUI();
    },

    /**
     * Exposes the resetStable method.
     * This is useful if you want to allow users to update the physics settings of your layout interactively
     */
    resetStable: resetStable,
    isStable: function () {
      isStable = true
    },
    setMaxDepth: function (maxDepth) {
      maxDepth = maxDepth
    },
    setMaxParticleCount: function (maxParticleCount) {
      maxParticleCount = maxParticleCount
    },

    /**
     * Stops animation and deallocates all allocated resources
     */
    dispose: dispose,

    // expose properties
    renderer: renderer,
    camera: camera,
    scene: scene,
    layout: layout
  };

  initialize(maxParticleCount, maxDepth);

  return graphics;

  function onFrame(cb) {
    // todo: allow multiple callbacks
    beforeFrameRender = cb;
  }

  function initialize() {
    console.log(`maxParticleCount: ${maxParticleCount}, maxDepth: ${maxDepth}`);
    nodeUI = {}; // Storage for UI of nodes

    graph.on('changed', onGraphChanged);

    if (settings.interactive) createControls();

    // ---------- Fog  ------
    scene.background = new THREE.Color(0x00141a);
    scene.fog = new THREE.FogExp2(0x003b4d, 0.00025);

    // ---------- Lights ----------
    scene.add(new THREE.AmbientLight(0x444444));

    var light1 = new THREE.DirectionalLight(0xffffff, 0.5);
    light1.position.set(1, 1, 1);
    scene.add(light1);

    var light2 = new THREE.DirectionalLight(0xffffff, 1.5);
    light2.position.set(0, -1, 0);
    scene.add(light2);

    // -------- Particles ----------
    group = new THREE.Group();
    scene.add(group);
    var helper = new THREE.BoxHelper(new THREE.Mesh(new THREE.BoxGeometry(r, r, r)));
    helper.material.color.setHex(0xfafafa);
    helper.material.blending = THREE.AdditiveBlending;
    helper.material.transparent = true;
    // group.add(helper);

    positions = new Float32Array(maxParticleCount * 6 * 3); // not sure about this number

    colors = new Float32Array(maxParticleCount * 6 * 3);

    var pMaterial = new THREE.PointsMaterial({
      color: 0xFF0000,
      size: 4,
      blending: THREE.AdditiveBlending,
      transparent: true,
      sizeAttenuation: true
    });

    particles = new THREE.BufferGeometry(maxParticleCount);
    particlePositions = new Float32Array(maxParticleCount * 3);

    particles.setDrawRange(0, 0);
    particles.addAttribute('position', new THREE.BufferAttribute(particlePositions, 3).setDynamic(true));

    // create the particle system
    pointCloud = new THREE.Points(particles, pMaterial);
    group.add(pointCloud);

    var geometry = new THREE.BufferGeometry();

    geometry.addAttribute('position', new THREE.BufferAttribute(positions, 3).setDynamic(true));
    geometry.addAttribute('color', new THREE.BufferAttribute(colors, 3).setDynamic(true));

    //geometry.computeBoundingSphere();

    geometry.setDrawRange(0, 0);

    // var material = new THREE.MeshDepthMaterial({color: 0x008060, side: THREE.DoubleSide});

    var material = new THREE.MeshLambertMaterial({
      color: 0xaaaaaa,
      side: THREE.DoubleSide,
      vertexColors: THREE.FaceColors,
      flatShading: false
    });

    mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
  }

  function run() {
    if (disposed) return;

    requestAnimationFrame(run);

    // Update the graph
    if (!isStable) {
      isStable = layout.step();
    }
    controls.update();
    renderOneFrame();
  }

  function dispose(options) {
    // let clients selectively choose what to dispose
    disposed = true;
    options = merge(options, {
      layout: true,
      dom: true,
      scene: true
    });

    beforeFrameRender = null;

    graph.off('changed', onGraphChanged);
    if (options.layout) layout.dispose();
    if (options.scene) {
      scene.traverse(function (object) {
        if (typeof object.deallocate === 'function') {
          object.deallocate();
        }
        disposeThreeObject(object.geometry);
        disposeThreeObject(object.material);
      });
    }

    if (options.dom) {
      var domElement = renderer.domElement;
      if (domElement && domElement.parentNode) {
        domElement.parentNode.removeChild(domElement);
      }
    }

    if (settings.interactive) {
      controls.removeEventListener('change', renderOneFrame);
      controls.dispose();
    }
  }

  function disposeThreeObject(obj) {
    if (!obj) return;

    if (obj.deallocate === 'function') {
      obj.deallocate();
    }
    if (obj.dispose === 'function') {
      obj.dispose();
    }
  }

  function renderOneFrame() {
    if (beforeFrameRender) {
      beforeFrameRender();
    }

    if (!isStable) {
      // Assign Particle positions
      for (var i = 0; i < nodeArray.length; i++) {
        particlePositions[i * 3] = nodeArray[i].pos.x;
        particlePositions[i * 3 + 1] = nodeArray[i].pos.y;
        if (nodeArray[i].depth !== null) {
          particlePositions[i * 3 + 2] = -1 * nodeArray[i].depth * HEIGHT_STEP;
        } else {
          particlePositions[i * 3 + 2] = -1 * maxDepth * HEIGHT_STEP;
        }
      }
      particles.setDrawRange(0, nodeArray.length);
      pointCloud.geometry.attributes.position.needsUpdate = true;

      // TODO: Maybe maxDepth should not be too big... looks weird
      if (triangles && triangles.length > 0) {
        for (var i = 0; i < triangles.length; i++) {
          positions[i * 3 + 0] = (nodeArray[triangles[i]].pos.x);
          positions[i * 3 + 1] = (nodeArray[triangles[i]].pos.y);
          if (nodeArray[triangles[i]].depth !== null) {
            positions[i * 3 + 2] = (-1 * nodeArray[triangles[i]].depth * HEIGHT_STEP);
          } else {
            positions[i * 3 + 2] = (-1 * maxDepth * HEIGHT_STEP);
          }

          // Colors can be per vertex of per triengle...
          if (i % 3 == 0) {
            trangleMinDepth = Math.min(nodeArray[triangles[i]].depth, nodeArray[triangles[i + 1]].depth, nodeArray[triangles[i + 2]].depth)
            let distanceFromSea = maxDepth - trangleMinDepth;
            if (distanceFromSea >= 10) {
              for (let j = 0; j < 9; j+=3) {
                colors[i * 3 + 0 + j] = colors[i * 3 + 1 + j] = colors[i * 3 + 2 + j] = 1;
              }
            } else if (distanceFromSea >= 3) {
              for (let j = 0; j < 9; j+=3) {
                colors[i * 3 + 0 + j] = 0.1;
                colors[i * 3 + 1 + j] = 1;
                colors[i * 3 + 2 + j] = 0.1;
              }
            } else if (distanceFromSea >= 1) {
              for (let j = 0; j < 9; j+=3) {
                colors[i * 3 + 0 + j] = 218 / 256;
                colors[i * 3 + 1 + j] = 165 / 256;
                colors[i * 3 + 2 + j] = 32 / 256;
              }
            } else {
              for (let j = 0; j < 9; j+=3) {
                colors[i * 3 + 0 + j] = 0.1;
                colors[i * 3 + 1 + j] = 0.1;
                colors[i * 3 + 2 + j] = 1;
              }
            }
          }

        }

        mesh.geometry.computeVertexNormals();
        mesh.geometry.normalizeNormals();
        mesh.geometry.setDrawRange(0, triangles.length * 3);
        mesh.geometry.attributes.position.needsUpdate = true;
        mesh.geometry.attributes.color.needsUpdate = true;
        mesh.geometry.attributes.normal.needsUpdate = true;
      }

    }

    renderer.render(scene, camera);
  }

  function initNode(node) {
    //console.log(node);
    var ui = {};

    // augment it with position data:
    ui.pos = layout.getNodePosition(node.id);

    let depth = (node.links &&
      node.links.length > 0 &&
      node.links[0].data &&
      node.links[0].data.depthOfChild) ? node.links[0].data.depthOfChild : 0;

    ui.depth = depth
    // and store for subsequent use:
    nodeUI[node.id] = ui;
    nodeArray.push(ui);

    if (!isStable) {
      triangles = throttledDelaunatorTriangles(nodeArray);
    }
  }

  function onGraphChanged(changes) {
    resetStable();
    for (var i = 0; i < changes.length; ++i) {
      var change = changes[i];
      if (change.changeType === 'add') {
        if (change.node) {
          initNode(change.node);
        }
      } else if (change.changeType === 'remove') {
        if (change.node) {
          var node = nodeUI[change.node.id];
          if (node) {
            scene.remove(node);
          }
          delete nodeUI[change.node.id];
        }
      }
    }
    // Call delaunator if this is still used.
  }

  function resetStable() {
    isStable = false;
  }

  function createLayout(settings) {
    if (settings.layout) {
      return settings.layout; // user has its own layout algorithm. Use it;
    }

    // otherwise let's create a default force directed layout:
    return require('ngraph.forcelayout3d')(graph, settings.physicsSettings);
  }

  function createRenderer(settings) {
    if (settings.renderer) {
      return settings.renderer;
    }

    var isWebGlSupported = (function () {
      try {
        var canvas = document.createElement('canvas');
        return !!window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
      } catch (e) {
        return false;
      }
    })();
    var renderer = isWebGlSupported ? new THREE.WebGLRenderer(settings) : new THREE.CanvasRenderer(settings);
    var width, height;
    if (settings.container) {
      width = settings.container.clientWidth;
      height = settings.container.clientHeight;
    } else {
      width = window.innerWidth;
      height = window.innerHeight;
    }
    renderer.setSize(width, height);

    if (settings.container) {
      settings.container.appendChild(renderer.domElement);
    } else {
      document.body.appendChild(renderer.domElement);
    }

    return renderer;
  }

  function createCamera(settings) {
    if (settings.camera) {
      return settings.camera;
    }
    var container = renderer.domElement;
    var camera = new THREE.PerspectiveCamera(90, container.clientWidth / container.clientHeight, 0.1, 5000);
    //var camera = new THREE.OrthographicCamera( container.clientWidth / - 2, container.clientWidth / 2, container.clientHeight / 2, container.clientHeight / - 2, 0.1, 5000 );
    camera.position.z = 400;
    return camera;
  }

  function createControls() {
    var Controls = require('three.trackball');
    controls = new Controls(camera, renderer.domElement);
    controls.panSpeed = 0.8;
    controls.staticMoving = true;
    controls.dynamicDampingFactor = 0.3;
    controls.addEventListener('change', renderOneFrame);
    graphics.controls = controls;
  }

  function rebuildUI() {
    nodeUI = {};
    graph.forEachNode(initNode);
  }

  function getDelaunayTriangles(nodeArray) {
    try {
      delaunay = new delaunator(nodeArray, (node) => node.pos.x, (node) => node.pos.y);
    } catch (e) {
      console.log(e);
    }
    if (delaunay) {
      // alphaComplex(ALPHA, delaunay.triangles, nodeArray);
      // get the Alpha shape
      //console.log(delaunay.triangles);
      // if (!normalsComputed) {
      //   mesh.geometry.computeVertexNormals();
      //   //normalsComputed = true;
      // }
      //mesh.geometry.normalizeNormals(); // -----> Do?
      return delaunay.triangles;
    }
    return null
  }

  function alphaComplex(alpha, triangles, nodeArray) {
    /*
    * The filter needs to be applied to faces, which means to sets of 3
    * in the triangles array.
    * So it is a MAP..?
    * For every 3 indices in triangles

    for (var i = 0; i < triangles.length; i += 3) {
      let simplex = [
                      [nodeArray[triangles[i]].pos.x, nodeArray[triangles[i]].pos.y]
                      [nodeArray[triangles[i+1]].pos.x, nodeArray[triangles[i+1]].pos.y]
                      [nodeArray[triangles[i+2]].pos.x, nodeArray[triangles[i+2]].pos.y]
                    ]; //this is the triangle. you idiot

      let circumradiusOfSimplex = circumradius(simplex);
      REMOVE_FLAG = ((circumradiusOfSimplex *alpha < 1)   && circumradius && circumradius ]
      if (REMOVE_FLAG) {
        triangles.splice(i, 3);
      }
    }


    *   get the circumradius of all the points in node
    *   REMOVE_FLAG =  (check the circumradius for nodeArray[triangles[i]] && check the circumradius for nodeArray[triangles[i+1]] && check the circumradius for nodeArray[triangles[i+2]]
    *   if  REMOVE_FLAG you have to remove triangles[i],triangles[i+1],triangles[i+2],
    *   triangles.splice(i, 3);
    */
    return triangles.filter(function (cell) {
      //let simplex =; // needs all the points here??????????
      return circumradius(simplex) * alpha < 1
    })
  }

};