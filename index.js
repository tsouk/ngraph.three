const THREE = require('three');
const delaunator = require('delaunator')
const _ = require('lodash');
const consoleThrottled = _.throttle(console.log, 500);

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
  let delaunay;
  let throttledDelaunatorTriangles = _.throttle(getDelaunayTriangles, 500);

  var material = new THREE.MeshStandardMaterial( { color : 0x00cc00 } );
  var geometry = new THREE.Geometry();
  scene.add( new THREE.Mesh( geometry, material ) );

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
    Object.keys(nodeUI).forEach(renderNode);
    let nodeArray = new Array();
    Object.keys(nodeUI).forEach(function(key) {
      //let point = [nodeUI[key].pos.x, nodeUI[key].pos.y];
      nodeArray.push(nodeUI[key]);
    });
    //console.log(nodeArray);
    //console.log(nodeArray[4]);
    // turn off line rendering, you still need the nodes... maybe
    // ngraph.three actually needs npm install the delaunator...
    // --------------


    // update ngraph.three with these changes before you rm -rf node_modules
    // if you turn off node rendering then you need to make the seaNode here

    // create the geometry outside here and add to scene, like an initGeometry()

    // maybe run the delaunator every 60 frames. Debounce it.
    // delaunay = new Delaunator(nodeUI, (node) => node.pos.x,  (nodeId) => node.pos.y); // doing this whenever nodes are added
    //getDelaunayTriangles(nodeArray);
    let triangles = throttledDelaunatorTriangles(nodeArray);
    // also add the seaNodes! remember, there is no LINE rendering now
    // ...maybe the graph has that already
    // YOU CAN push the whole node, or at least add the depth.

    // get the triangle indices that map to the points[]

    // push their coordinates all in geometry.vertices array, and z = -1 * depth * HEIGHT_STEP
    // make a face for all these, every 3 of them

    // make the geometry?

    // for (var i = 0; i < geometry.vertices.length; i += 3) {
    //   //create a new face using vertices 0, 1, 2
    //   var normal = new THREE.Vector3( 0, 1, 0 ); //optional
    //   var color = new THREE.Color( 0xffaa00 ); //optional
    //   var materialIndex = 0; //optional
    //   // var face = new THREE.Face3( 0, 1, 2, normal, color, materialIndex );
    //   var face = new THREE.Face3( triangles[i], triangles[i+1], triangles[i+2], normal, color, materialIndex );
    //   geometry.faces.push( face );
    // }


    renderer.render(scene, camera);
  }

  function renderNode(nodeId) {
    nodeRenderer(nodeUI[nodeId]);
  }

  function renderLink(linkId) {
    linkRenderer(linkUI[linkId]);
  }

  function initNode(node) {
    var ui = nodeUIBuilder(node);
    if (!ui) return;
    // augment it with position data:
    ui.pos = layout.getNodePosition(node.id);
    // and store for subsequent use:
    nodeUI[node.id] = ui;

    scene.add(ui);
  }

  function initLink(link) {
    var ui = linkUIBuilder(link);
    if (!ui) return;

    ui.from = layout.getNodePosition(link.fromId);
    ui.to = layout.getNodePosition(link.toId);

    linkUI[link.id] = ui;
    scene.add(ui);
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
      //console.log(delaunay.triangles);
      return delaunay.triangles;
    }
    return null
  }

};
