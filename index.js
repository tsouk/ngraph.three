const THREE = require('three');
const delaunator = require('delaunator');
const circumradius = require('circumradius');
const _ = require('lodash');
const DEL_THROTTLE = 500;
const ALPHA = 20;
const HEIGHT_STEP = 30;
const consoleThrottled = _.throttle(console.log, DEL_THROTTLE);

module.exports = function (graph, settings) {
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
  let maxDepth = 0;

  // -------- Particles ----------
  var group;
  var pointCloud;
  var maxParticleCount = 1500; //TODO: get the right number from recurseBF. IT IS KNOWN!
  var particleCount = 1500; // TODO: DO THISSS!!!
  var particlesData = [];
  var particlePositions;
  var linesMesh;
  var positions, colors;
  var particles;
  var r = 800;
  var rHalf = r / 2;



  
  // -------------------------------------------------------


  var defaults = require('./lib/defaults');

  // Default callbacks to build/render nodes and links
  var nodeUIBuilder, nodeRenderer, linkUIBuilder, linkRenderer;

  var nodeUI, linkUI; // Storage for UI of nodes/links
  var controls = { update: function noop() {} };

  var graphics = {
    THREE: THREE, // expose THREE so that clients will not have to require it twice.
    run: run,
    renderOneFrame: renderOneFrame,

    onFrame: onFrame,

    /**
     * Gets UI object for a given node id
     */
    getNodeUI : function (nodeId) {
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
    createNodeUI : function (createNodeUICallback) {
      nodeUIBuilder = createNodeUICallback;
      rebuildUI();
      return this;
    },


    /**
     * Force a rebuild of the UI. This might be necessary after settings have changed
     */
    rebuild : function () {
      rebuildUI();
    },

    /**
     * This callback is called by graphics when it wants to render node on
     * a screen.
     *
     * @callback renderNodeCallback
     * @param {object} node - result of createNodeUICallback(). It contains anything
     * you'd need to render a node
     */
    /**
     * Allows clients to pass custom node rendering callback
     *
     * @param {renderNodeCallback} renderNodeCallback - Callback which renders
     * node.
     *
     * @returns {object} this for chaining.
     */
    renderNode: function (renderNodeCallback) {
      nodeRenderer = renderNodeCallback;
      return this;
    },

    /**
     * This callback creates new UI for a graph link. This becomes helpful
     * when you want to precalculate some properties, which otherwise could be
     * expensive during rendering frame.
     *
     * @callback createLinkUICallback
     * @param {object} link - graph link for which UI is required.
     * @returns {object} arbitrary object which will be later passed to renderNode
     */
    /**
     * This function allows clients to pass custom node UI creation callback
     *
     * @param {createLinkUICallback} createLinkUICallback - The callback that
     * creates new link UI
     * @returns {object} this for chaining.
     */
    createLinkUI : function (createLinkUICallback) {
      linkUIBuilder = createLinkUICallback;
      rebuildUI();
      return this;
    },

    /**
     * This callback is called by graphics when it wants to render link on
     * a screen.
     *
     * @callback renderLinkCallback
     * @param {object} link - result of createLinkUICallback(). It contains anything
     * you'd need to render a link
     */
    /**
     * Allows clients to pass custom link rendering callback
     *
     * @param {renderLinkCallback} renderLinkCallback - Callback which renders
     * link.
     *
     * @returns {object} this for chaining.
     */
    renderLink: function (renderLinkCallback) {
      linkRenderer = renderLinkCallback;
      return this;
    },

    /**
     * Exposes the resetStable method.
     * This is useful if you want to allow users to update the physics settings of your layout interactively
     */
    resetStable: resetStable,
    isStable: function() {isStable = true},

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

  initialize();

  return graphics;

  function onFrame(cb) {
    // todo: allow multiple callbacks
    beforeFrameRender = cb;
  }

  function initialize() {
    nodeUIBuilder = defaults.createNodeUI;
    nodeRenderer  = defaults.nodeRenderer;
    linkUIBuilder = defaults.createLinkUI;
    linkRenderer  = defaults.linkRenderer;
    nodeUI = {}; linkUI = {}; // Storage for UI of nodes/links

    graph.forEachLink(initLink);
    graph.forEachNode(initNode);

    graph.on('changed', onGraphChanged);

    if (settings.interactive) createControls();

    //scene.fog = new THREE.Fog( 0x050505, 2000, 3500 );
    // ---------- Lights ----------

    scene.add( new THREE.AmbientLight( 0x444444 ) );

    var light1 = new THREE.DirectionalLight( 0xffffff, 0.5 );
    light1.position.set( 1, 1, 1 );
    scene.add( light1 );

    var light2 = new THREE.DirectionalLight( 0xffffff, 1.5 );
    light2.position.set( 0, -1, 0 );
    scene.add( light2 );


    // -------- Particles ----------
    group = new THREE.Group();
    scene.add( group );
    var helper = new THREE.BoxHelper( new THREE.Mesh( new THREE.BoxGeometry( r, r, r ) ) );
    helper.material.color.setHex( 0x080808 );
    helper.material.blending = THREE.AdditiveBlending;
    helper.material.transparent = true;
    group.add( helper );
    var segments = maxParticleCount * maxParticleCount;

    positions = new Float32Array( segments * 3 );
    
    var faceColor = new THREE.Color( 0x108060 );
    colors = new Float32Array( maxParticleCount * 3 );
    for (let index = 0; index < colors.length; index += 3) {
      colors[index] = faceColor.r;
      colors[index+1] = faceColor.g;
      colors[index+2] = faceColor.b;
    }

    var pMaterial = new THREE.PointsMaterial( {
      color: 0xFF0000,
      size: 5,
      //blending: THREE.AdditiveBlending,
      transparent: true,
      sizeAttenuation: false
    } );

    particles = new THREE.BufferGeometry();
    particlePositions = new Float32Array( maxParticleCount * 3 );

    particles.setDrawRange( 0, particleCount );
    particles.addAttribute( 'position', new THREE.BufferAttribute( particlePositions, 3 ).setDynamic( true ) );

    // create the particle system
    pointCloud = new THREE.Points( particles, pMaterial );
    group.add( pointCloud );

    var geometry = new THREE.BufferGeometry();

    geometry.addAttribute( 'position', new THREE.BufferAttribute( positions, 3 ).setDynamic( true ) );
    // add normals???
    geometry.addAttribute( 'color', new THREE.BufferAttribute( colors, 3 ).setDynamic( true ) );

    geometry.computeBoundingSphere();

    geometry.setDrawRange( 0, 0 );

    // var material = new THREE.LineBasicMaterial( {
    //   vertexColors: THREE.VertexColors,
    //   //blending: THREE.AdditiveBlending,
    //   transparent: true
    // } );

    var material = new THREE.MeshPhongMaterial( {
      color: 0xaaaaaa, specular: 0xffffff, shininess: 50,
      side: THREE.DoubleSide, vertexColors: THREE.VertexColors, flatShading: false
    } );

    mesh = new THREE.Mesh( geometry, material );
    group.add( mesh );
  }

  function run() {
    if (disposed) return;

    requestAnimationFrame(run);
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
      if(domElement && domElement.parentNode) {
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
    // todo: this adds GC pressure. Remove functional iterators
    //Object.keys(linkUI).forEach(renderLink);
    //Object.keys(nodeUI).forEach(renderNode);
   
    // Object.keys(nodeUI).forEach(function(key) {
      // renderNode(key);
    // });

    for ( var i = 0; i < nodeArray.length; i++ ) {
      particlePositions[ i * 3     ] = nodeArray[i].pos.x;
      particlePositions[ i * 3 + 1 ] = nodeArray[i].pos.y;
      if (nodeArray[i].userData.depth) {
        particlePositions[ i * 3 + 2 ] = -1 * nodeArray[i].userData.depth * HEIGHT_STEP;
      }
      else {
        particlePositions[ i * 3 + 2 ] = -1 * maxDepth * HEIGHT_STEP;
      }
    }
    //console.log(particlePositions);
    particles.setDrawRange( 0, nodeArray.length );
    pointCloud.geometry.attributes.position.needsUpdate = true;

    // TODO: find the best place to call the Delaunator
    // if (!isStable) {
    //   triangles = throttledDelaunatorTriangles(nodeArray);
    // }
    if (triangles && triangles.length > 0) {
      for ( var i = 0; i < triangles.length; i++ )  {
        positions[ i * 3 + 0 ] = (nodeArray[triangles[i]].pos.x);
        positions[ i * 3 + 1 ] = (nodeArray[triangles[i]].pos.y);
        if (nodeArray[triangles[i]].userData.depth) {
          positions[ i * 3 + 2 ] = (-1 * nodeArray[triangles[i]].userData.depth * HEIGHT_STEP);
        }
        else {
          positions[ i * 3 + 2 ] = (-1 * maxDepth * HEIGHT_STEP);
        }
      }

      // COMPUTE THE NORMALS YOURSELF, currently computed with the dalaunay... which is kind of ok.

      mesh.geometry.setDrawRange( 0, triangles.length * 3 );
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.color.needsUpdate = true;
      mesh.geometry.attributes.normal.needsUpdate = true;
      
    }

    renderer.render(scene, camera);
  }

  function renderNode(nodeId) {
    nodeRenderer(nodeUI[nodeId]);
  }

  function renderLink(linkId) {
    linkRenderer(linkUI[linkId]);
  }

  function initNode(node) {
    // console.log(node);
    // this shit has to change, I don't need the mesh at all...
    var ui = nodeUIBuilder(node); // TODO: this is the nodeS that are hanging around
    if (!ui) return;
    // augment it with position data:
    ui.pos = layout.getNodePosition(node.id);
    // and store for subsequent use:
    nodeUI[node.id] = ui;

    let depth = (node.links &&
      node.links.length > 0 &&
      node.links[0].data &&
      node.links[0].data.depthOfChild) ? node.links[0].data.depthOfChild : 0;
    nodeUI[node.id].userData.depth = depth; 
    maxDepth = maxDepth < depth ? depth : maxDepth;
    //console.log(maxDepth);
    nodeArray.push(ui);
    
    Object.keys(nodeUI).forEach(function(key) {
      if (!nodeUI[key].userData.seaNode && nodeUI[key].userData.depth < maxDepth) {
        nodeUI[key].userData.seaNode = {
          pos: {
            x: nodeUI[key].pos.x, //got the pos.x of the father below!!!
            y: nodeUI[key].pos.y
          },
          userData: {
            depth: null // this doeanst workk
          }
        }
        // console.log('adding seanode');

        nodeArray.push(nodeUI[key].userData.seaNode); // <-------- Add it?

        // console.group();
        // console.log(nodeUI[key].userData.seaNode);
        // console.log(nodeUI[node.links[0].fromId].pos.x); //pos.x of the father!!!
        // console.groupEnd();
      }
    });


    //---------------------> nodeArray.push(seaNode) !!!!

    if (!isStable) {
      triangles = throttledDelaunatorTriangles(nodeArray);
    }

    //scene.add(ui);
  }

  function initLink(link) {
    var ui = linkUIBuilder(link);
    if (!ui) return;

    ui.from = layout.getNodePosition(link.fromId);
    ui.to = layout.getNodePosition(link.toId);

    linkUI[link.id] = ui;
    //scene.add(ui);
  }

  function onGraphChanged(changes) {
    resetStable();
    for (var i = 0; i < changes.length; ++i) {
      var change = changes[i];
      if (change.changeType === 'add') {
        if (change.node) {
          initNode(change.node);
        }
        if (change.link) {
          initLink(change.link);
        }
      } else if (change.changeType === 'remove') {
        if (change.node) {
          var node = nodeUI[change.node.id];
          if (node) { scene.remove(node); }
          delete nodeUI[change.node.id];
        }
        if (change.link) {
          var link = linkUI[change.link.id];
          if (link) { scene.remove(link); }
          delete linkUI[change.link.id];
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

    var isWebGlSupported = ( function () { try { var canvas = document.createElement( 'canvas' ); return !! window.WebGLRenderingContext && ( canvas.getContext( 'webgl' ) || canvas.getContext( 'experimental-webgl' ) ); } catch( e ) { return false; } } )();
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
    var camera = new THREE.PerspectiveCamera(75, container.clientWidth/container.clientHeight, 0.1, 3000);
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
    Object.keys(nodeUI).forEach(function (nodeId) {
      scene.remove(nodeUI[nodeId]);
    });
    nodeUI = {};

    Object.keys(linkUI).forEach(function (linkId) {
      scene.remove(linkUI[linkId]);
    });
    linkUI = {};

    graph.forEachLink(initLink);
    graph.forEachNode(initNode);
  }

  function getDelaunayTriangles(nodeArray) {
    try {
      delaunay = new delaunator(nodeArray, (node) => node.pos.x,  (node) => node.pos.y);
    }
    catch (e) {
      console.log(e);
    }
    if (delaunay) {
      // alphaComplex(ALPHA, delaunay.triangles, nodeArray);
      // get the Alpha shape
      //console.log(delaunay.triangles);
      mesh.geometry.computeVertexNormals();
      //mesh.geometry.normalizeNormals();
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
    return triangles.filter(function(cell) {
      //let simplex =; // needs all the points here??????????
      return circumradius(simplex) * alpha < 1
    })
  }

};