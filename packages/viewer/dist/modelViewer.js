import { Object3D, SphereGeometry, MeshBasicMaterial, Mesh, PerspectiveCamera, Scene, Color, WebGLRenderer, sRGBEncoding, PMREMGenerator, UnsignedByteType, BufferGeometry, Float32BufferAttribute, LineBasicMaterial, VertexColors, AdditiveBlending, Line } from './three/build/three.module.js';
import { OrbitControls } from './three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from './three/examples/jsm/loaders/RGBELoader.js';
import { VRButton } from './three/examples/jsm/webxr/VRButton.js';
import { GLTFLoader } from './three/examples/jsm/loaders/GLTFLoader.js';
import { Constants, fetchProfilesList, fetchProfile, MotionController } from './motion-controllers.module.js';
import './ajv/ajv.min.js';
import validateRegistryProfile from './registryTools/validateRegistryProfile.js';
import expandRegistryProfile from './assetTools/expandRegistryProfile.js';
import buildAssetProfile from './assetTools/buildAssetProfile.js';

let motionController;
let mockGamepad;
let controlsListElement;

function updateText() {
  if (motionController) {
    Object.values(motionController.components).forEach((component) => {
      const dataElement = document.getElementById(`${component.id}_data`);
      dataElement.innerHTML = JSON.stringify(component.data, null, 2);
    });
  }
}

function onButtonValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].value = Number(event.target.value);
}

function onAxisValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.axes[index] = Number(event.target.value);
}

function clear() {
  motionController = undefined;
  mockGamepad = undefined;

  if (!controlsListElement) {
    controlsListElement = document.getElementById('controlsList');
  }
  controlsListElement.innerHTML = '';
}

function addButtonControls(componentControlsElement, buttonIndex) {
  const buttonControlsElement = document.createElement('div');
  buttonControlsElement.setAttribute('class', 'componentControls');

  buttonControlsElement.innerHTML += `
  <label>buttonValue</label>
  <input id="buttons[${buttonIndex}].value" data-index="${buttonIndex}" type="range" min="0" max="1" step="0.01" value="0">
  `;

  componentControlsElement.appendChild(buttonControlsElement);

  document.getElementById(`buttons[${buttonIndex}].value`).addEventListener('input', onButtonValueChange);
}

function addAxisControls(componentControlsElement, axisName, axisIndex) {
  const axisControlsElement = document.createElement('div');
  axisControlsElement.setAttribute('class', 'componentControls');

  axisControlsElement.innerHTML += `
  <label>${axisName}<label>
  <input id="axes[${axisIndex}]" data-index="${axisIndex}"
          type="range" min="-1" max="1" step="0.01" value="0">
  `;

  componentControlsElement.appendChild(axisControlsElement);

  document.getElementById(`axes[${axisIndex}]`).addEventListener('input', onAxisValueChange);
}

function build(sourceMotionController) {
  clear();

  motionController = sourceMotionController;
  mockGamepad = motionController.xrInputSource.gamepad;

  Object.values(motionController.components).forEach((component) => {
    const componentControlsElement = document.createElement('li');
    componentControlsElement.setAttribute('class', 'component');
    controlsListElement.appendChild(componentControlsElement);

    const headingElement = document.createElement('h4');
    headingElement.innerText = `${component.id}`;
    componentControlsElement.appendChild(headingElement);

    if (component.gamepadIndices.button !== undefined) {
      addButtonControls(componentControlsElement, component.gamepadIndices.button);
    }

    if (component.gamepadIndices.xAxis !== undefined) {
      addAxisControls(componentControlsElement, 'xAxis', component.gamepadIndices.xAxis);
    }

    if (component.gamepadIndices.yAxis !== undefined) {
      addAxisControls(componentControlsElement, 'yAxis', component.gamepadIndices.yAxis);
    }

    const dataElement = document.createElement('pre');
    dataElement.id = `${component.id}_data`;
    componentControlsElement.appendChild(dataElement);
  });
}

var ManualControls = { clear, build, updateText };

let errorsSectionElement;
let errorsListElement;
class AssetError extends Error {
  constructor(...params) {
    super(...params);
    AssetError.log(this.message);
  }

  static initialize() {
    errorsListElement = document.getElementById('errors');
    errorsSectionElement = document.getElementById('errors');
  }

  static log(errorMessage) {
    const itemElement = document.createElement('li');
    itemElement.innerText = errorMessage;
    errorsListElement.appendChild(itemElement);
    errorsSectionElement.hidden = false;
  }

  static clearAll() {
    errorsListElement.innerHTML = '';
    errorsSectionElement.hidden = true;
  }
}

/* eslint-disable import/no-unresolved */

const gltfLoader = new GLTFLoader();

class ControllerModel extends Object3D {
  constructor() {
    super();
    this.xrInputSource = null;
    this.motionController = null;
    this.asset = null;
    this.rootNode = null;
    this.nodes = {};
    this.loaded = false;
    this.envMap = null;
  }

  set environmentMap(value) {
    if (this.envMap === value) {
      return;
    }

    this.envMap = value;
    /* eslint-disable no-param-reassign */
    this.traverse((child) => {
      if (child.isMesh) {
        child.material.envMap = this.envMap;
        child.material.needsUpdate = true;
      }
    });
    /* eslint-enable */
  }

  get environmentMap() {
    return this.envMap;
  }

  async initialize(motionController) {
    this.motionController = motionController;
    this.xrInputSource = this.motionController.xrInputSource;

    // Fetch the assets and generate threejs objects for it
    this.asset = await new Promise(((resolve, reject) => {
      gltfLoader.load(
        motionController.assetUrl,
        (loadedAsset) => { resolve(loadedAsset); },
        null,
        () => { reject(new AssetError(`Asset ${motionController.assetUrl} missing or malformed.`)); }
      );
    }));

    if (this.envMap) {
      /* eslint-disable no-param-reassign */
      this.asset.scene.traverse((child) => {
        if (child.isMesh) {
          child.material.envMap = this.envMap;
        }
      });
      /* eslint-enable */
    }

    this.rootNode = this.asset.scene;
    this.addTouchDots();
    this.findNodes();
    this.add(this.rootNode);
    this.loaded = true;
  }

  /**
   * Polls data from the XRInputSource and updates the model's components to match
   * the real world data
   */
  updateMatrixWorld(force) {
    super.updateMatrixWorld(force);

    if (!this.loaded) {
      return;
    }

    // Cause the MotionController to poll the Gamepad for data
    this.motionController.updateFromGamepad();

    // Update the 3D model to reflect the button, thumbstick, and touchpad state
    Object.values(this.motionController.components).forEach((component) => {
      // Update node data based on the visual responses' current states
      Object.values(component.visualResponses).forEach((visualResponse) => {
        const {
          valueNodeName, minNodeName, maxNodeName, value, valueNodeProperty
        } = visualResponse;
        const valueNode = this.nodes[valueNodeName];

        // Skip if the visual response node is not found. No error is needed,
        // because it will have been reported at load time.
        if (!valueNode) return;

        // Calculate the new properties based on the weight supplied
        if (valueNodeProperty === Constants.VisualResponseProperty.VISIBILITY) {
          valueNode.visible = value;
        } else if (valueNodeProperty === Constants.VisualResponseProperty.TRANSFORM) {
          const minNode = this.nodes[minNodeName];
          const maxNode = this.nodes[maxNodeName];
          valueNode.quaternion.slerpQuaternions(
            minNode.quaternion,
            maxNode.quaternion,
            value
          );

          valueNode.position.lerpVectors(
            minNode.position,
            maxNode.position,
            value
          );
        }
      });
    });
  }

  /**
   * Walks the model's tree to find the nodes needed to animate the components and
   * saves them for use in the frame loop
   */
  findNodes() {
    this.nodes = {};

    // Loop through the components and find the nodes needed for each components' visual responses
    Object.values(this.motionController.components).forEach((component) => {
      const { touchPointNodeName, visualResponses } = component;
      if (touchPointNodeName) {
        this.nodes[touchPointNodeName] = this.rootNode.getObjectByName(touchPointNodeName);
      }

      // Loop through all the visual responses to be applied to this component
      Object.values(visualResponses).forEach((visualResponse) => {
        const {
          valueNodeName, minNodeName, maxNodeName, valueNodeProperty
        } = visualResponse;
        // If animating a transform, find the two nodes to be interpolated between.
        if (valueNodeProperty === Constants.VisualResponseProperty.TRANSFORM) {
          this.nodes[minNodeName] = this.rootNode.getObjectByName(minNodeName);
          this.nodes[maxNodeName] = this.rootNode.getObjectByName(maxNodeName);

          // If the extents cannot be found, skip this animation
          if (!this.nodes[minNodeName]) {
            AssetError.log(`Could not find ${minNodeName} in the model`);
            return;
          }
          if (!this.nodes[maxNodeName]) {
            AssetError.log(`Could not find ${maxNodeName} in the model`);
            return;
          }
        }

        // If the target node cannot be found, skip this animation
        this.nodes[valueNodeName] = this.rootNode.getObjectByName(valueNodeName);
        if (!this.nodes[valueNodeName]) {
          AssetError.log(`Could not find ${valueNodeName} in the model`);
        }
      });
    });
  }

  /**
   * Add touch dots to all touchpad components so the finger can be seen
   */
  addTouchDots() {
    Object.keys(this.motionController.components).forEach((componentId) => {
      const component = this.motionController.components[componentId];
      // Find the touchpads
      if (component.type === Constants.ComponentType.TOUCHPAD) {
        // Find the node to attach the touch dot.
        const touchPointRoot = this.rootNode.getObjectByName(component.touchPointNodeName, true);
        if (!touchPointRoot) {
          AssetError.log(`Could not find touch dot, ${component.touchPointNodeName}, in touchpad component ${componentId}`);
        } else {
          const sphereGeometry = new SphereGeometry(0.001);
          const material = new MeshBasicMaterial({ color: 0x0000FF });
          const sphere = new Mesh(sphereGeometry, material);
          touchPointRoot.add(sphere);
        }
      }
    });
  }
}

/* eslint-disable import/no-unresolved */

/**
 * Loads a profile from a set of local files
 */
class LocalProfile extends EventTarget {
  constructor() {
    super();

    this.localFilesListElement = document.getElementById('localFilesList');
    this.filesSelector = document.getElementById('localFilesSelector');
    this.filesSelector.addEventListener('change', () => {
      this.onFilesSelected();
    });

    this.clear();

    LocalProfile.buildSchemaValidator('registryTools/registrySchemas.json').then((registrySchemaValidator) => {
      this.registrySchemaValidator = registrySchemaValidator;
      LocalProfile.buildSchemaValidator('assetTools/assetSchemas.json').then((assetSchemaValidator) => {
        this.assetSchemaValidator = assetSchemaValidator;
        const duringPageLoad = true;
        this.onFilesSelected(duringPageLoad);
      });
    });
  }

  /**
   * Clears all local profile information
   */
  clear() {
    if (this.profile) {
      this.profile = null;
      this.profileId = null;
      this.assets = [];
      this.localFilesListElement.innerHTML = '';

      const changeEvent = new Event('localProfileChange');
      this.dispatchEvent(changeEvent);
    }
  }

  /**
   * Processes selected files and generates an asset profile
   * @param {boolean} duringPageLoad
   */
  async onFilesSelected(duringPageLoad) {
    this.clear();

    // Skip if initialzation is incomplete
    if (!this.assetSchemaValidator) {
      return;
    }

    // Examine the files selected to find the registry profile, asset overrides, and asset files
    const assets = [];
    let assetJsonFile;
    let registryJsonFile;

    const filesList = Array.from(this.filesSelector.files);
    filesList.forEach((file) => {
      if (file.name.endsWith('.glb')) {
        assets[file.name] = window.URL.createObjectURL(file);
      } else if (file.name === 'profile.json') {
        assetJsonFile = file;
      } else if (file.name.endsWith('.json')) {
        registryJsonFile = file;
      }

      // List the files found
      this.localFilesListElement.innerHTML += `
        <li>${file.name}</li>
      `;
    });

    if (!registryJsonFile) {
      AssetError.log('No registry profile selected');
      return;
    }

    await this.buildProfile(registryJsonFile, assetJsonFile, assets);
    this.assets = assets;

    // Change the selected profile to the one just loaded.  Do not do this on initial page load
    // because the selected files persists in firefox across refreshes, but the user may have
    // selected a different item from the dropdown
    if (!duringPageLoad) {
      window.localStorage.setItem('profileId', this.profileId);
    }

    // Notify that the local profile is ready for use
    const changeEvent = new Event('localprofilechange');
    this.dispatchEvent(changeEvent);
  }

  /**
   * Build a merged profile file from the registry profile and asset overrides
   * @param {*} registryJsonFile
   * @param {*} assetJsonFile
   */
  async buildProfile(registryJsonFile, assetJsonFile) {
    // Load the registry JSON and validate it against the schema
    const registryJson = await LocalProfile.loadLocalJson(registryJsonFile);
    const isRegistryJsonValid = this.registrySchemaValidator(registryJson);
    if (!isRegistryJsonValid) {
      throw new AssetError(JSON.stringify(this.registrySchemaValidator.errors, null, 2));
    }

    // Load the asset JSON and validate it against the schema.
    // If no asset JSON present, use the default definiton
    let assetJson;
    if (!assetJsonFile) {
      assetJson = { profileId: registryJson.profileId, overrides: {} };
    } else {
      assetJson = await LocalProfile.loadLocalJson(assetJsonFile);
      const isAssetJsonValid = this.assetSchemaValidator(assetJson);
      if (!isAssetJsonValid) {
        throw new AssetError(JSON.stringify(this.assetSchemaValidator.errors, null, 2));
      }
    }

    // Validate non-schema requirements and build a combined profile
    validateRegistryProfile(registryJson);
    const expandedRegistryProfile = expandRegistryProfile(registryJson);
    this.profile = buildAssetProfile(assetJson, expandedRegistryProfile);
    this.profileId = this.profile.profileId;
  }

  /**
   * Helper to load JSON from a local file
   * @param {File} jsonFile
   */
  static loadLocalJson(jsonFile) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const json = JSON.parse(reader.result);
        resolve(json);
      };

      reader.onerror = () => {
        const errorMessage = `Unable to load JSON from ${jsonFile.name}`;
        AssetError.log(errorMessage);
        reject(errorMessage);
      };

      reader.readAsText(jsonFile);
    });
  }

  /**
   * Helper to load the combined schema file and compile an AJV validator
   * @param {string} schemasPath
   */
  static async buildSchemaValidator(schemasPath) {
    const response = await fetch(schemasPath);
    if (!response.ok) {
      throw new AssetError(response.statusText);
    }

    // eslint-disable-next-line no-undef
    const ajv = new Ajv();
    const schemas = await response.json();
    schemas.dependencies.forEach((schema) => {
      ajv.addSchema(schema);
    });

    return ajv.compile(schemas.mainSchema);
  }
}

/* eslint-disable import/no-unresolved */

const profilesBasePath = './profiles';

/**
 * Loads profiles from the distribution folder next to the viewer's location
 */
class ProfileSelector extends EventTarget {
  constructor() {
    super();

    // Get the profile id selector and listen for changes
    this.profileIdSelectorElement = document.getElementById('profileIdSelector');
    this.profileIdSelectorElement.addEventListener('change', () => { this.onProfileIdChange(); });

    // Get the handedness selector and listen for changes
    this.handednessSelectorElement = document.getElementById('handednessSelector');
    this.handednessSelectorElement.addEventListener('change', () => { this.onHandednessChange(); });

    this.forceVRProfileElement = document.getElementById('forceVRProfile');
    this.showTargetRayElement = document.getElementById('showTargetRay');

    this.localProfile = new LocalProfile();
    this.localProfile.addEventListener('localprofilechange', (event) => { this.onLocalProfileChange(event); });

    this.profilesList = null;
    this.populateProfileSelector();
  }

  /**
   * Resets all selected profile state
   */
  clearSelectedProfile() {
    AssetError.clearAll();
    this.profile = null;
    this.handedness = null;
  }

  /**
   * Retrieves the full list of available profiles and populates the dropdown
   */
  async populateProfileSelector() {
    this.clearSelectedProfile();
    this.handednessSelectorElement.innerHTML = '';

    // Load and clear local storage
    const storedProfileId = window.localStorage.getItem('profileId');
    window.localStorage.removeItem('profileId');

    // Load the list of profiles
    if (!this.profilesList) {
      try {
        this.profileIdSelectorElement.innerHTML = '<option value="loading">Loading...</option>';
        this.profilesList = await fetchProfilesList(profilesBasePath);
      } catch (error) {
        this.profileIdSelectorElement.innerHTML = 'Failed to load list';
        AssetError.log(error.message);
        throw error;
      }
    }

    // Add each profile to the dropdown
    this.profileIdSelectorElement.innerHTML = '';
    Object.keys(this.profilesList).forEach((profileId) => {
      const profile = this.profilesList[profileId];
      if (!profile.deprecated) {
        this.profileIdSelectorElement.innerHTML += `
        <option value='${profileId}'>${profileId}</option>
        `;
      }
    });

    // Add the local profile if it isn't already included
    if (this.localProfile.profileId
     && !Object.keys(this.profilesList).includes(this.localProfile.profileId)) {
      this.profileIdSelectorElement.innerHTML += `
      <option value='${this.localProfile.profileId}'>${this.localProfile.profileId}</option>
      `;
      this.profilesList[this.localProfile.profileId] = this.localProfile;
    }

    // Override the default selection if values were present in local storage
    if (storedProfileId) {
      this.profileIdSelectorElement.value = storedProfileId;
    }

    // Manually trigger selected profile to load
    this.onProfileIdChange();
  }

  /**
   * Handler for the profile id selection change
   */
  onProfileIdChange() {
    this.clearSelectedProfile();
    this.handednessSelectorElement.innerHTML = '';

    const profileId = this.profileIdSelectorElement.value;
    window.localStorage.setItem('profileId', profileId);

    if (profileId === this.localProfile.profileId) {
      this.profile = this.localProfile.profile;
      this.populateHandednessSelector();
    } else {
      // Attempt to load the profile
      this.profileIdSelectorElement.disabled = true;
      this.handednessSelectorElement.disabled = true;
      fetchProfile({ profiles: [profileId], handedness: 'any' }, profilesBasePath, null, false).then(({ profile }) => {
        this.profile = profile;
        this.populateHandednessSelector();
      })
        .catch((error) => {
          AssetError.log(error.message);
          throw error;
        })
        .finally(() => {
          this.profileIdSelectorElement.disabled = false;
          this.handednessSelectorElement.disabled = false;
        });
    }
  }

  /**
   * Populates the handedness dropdown with those supported by the selected profile
   */
  populateHandednessSelector() {
    // Load and clear the last selection for this profile id
    const storedHandedness = window.localStorage.getItem('handedness');
    window.localStorage.removeItem('handedness');

    // Populate handedness selector
    Object.keys(this.profile.layouts).forEach((handedness) => {
      this.handednessSelectorElement.innerHTML += `
        <option value='${handedness}'>${handedness}</option>
      `;
    });

    // Apply stored handedness if found
    if (storedHandedness && this.profile.layouts[storedHandedness]) {
      this.handednessSelectorElement.value = storedHandedness;
    }

    // Manually trigger selected handedness change
    this.onHandednessChange();
  }

  /**
   * Responds to changes in selected handedness.
   * Creates a new motion controller for the combination of profile and handedness, and fires an
   * event to signal the change
   */
  onHandednessChange() {
    AssetError.clearAll();
    this.handedness = this.handednessSelectorElement.value;
    window.localStorage.setItem('handedness', this.handedness);
    if (this.handedness) {
      this.dispatchEvent(new Event('selectionchange'));
    } else {
      this.dispatchEvent(new Event('selectionclear'));
    }
  }

  /**
   * Updates the profiles dropdown to ensure local profile is in the list
   */
  onLocalProfileChange() {
    this.populateProfileSelector();
  }

  /**
   * Indicates if the currently selected profile should be shown in VR instead
   * of the profiles advertised by the real XRInputSource.
   */
  get forceVRProfile() {
    return this.forceVRProfileElement.checked;
  }

  /**
   * Indicates if the targetRaySpace for an input source should be visualized in
   * VR.
   */
  get showTargetRay() {
    return this.showTargetRayElement.checked;
  }

  /**
   * Builds a MotionController either based on the supplied input source using the local profile
   * if it is the best match, otherwise uses the remote assets
   * @param {XRInputSource} xrInputSource
   */
  async createMotionController(xrInputSource) {
    let profile;
    let assetPath;

    // Check if local override should be used
    let useLocalProfile = false;
    if (this.localProfile.profileId) {
      xrInputSource.profiles.some((profileId) => {
        const matchFound = Object.keys(this.profilesList).includes(profileId);
        useLocalProfile = matchFound && (profileId === this.localProfile.profileId);
        return matchFound;
      });
    }

    // Get profile and asset path
    if (useLocalProfile) {
      ({ profile } = this.localProfile);
      const assetName = this.localProfile.profile.layouts[xrInputSource.handedness].assetPath;
      assetPath = this.localProfile.assets[assetName] || assetName;
    } else {
      ({ profile, assetPath } = await fetchProfile(xrInputSource, profilesBasePath));
    }

    // Build motion controller
    const motionController = new MotionController(
      xrInputSource,
      profile,
      assetPath
    );

    return motionController;
  }
}

const defaultBackground = 'georgentor';

class BackgroundSelector extends EventTarget {
  constructor() {
    super();

    this.backgroundSelectorElement = document.getElementById('backgroundSelector');
    this.backgroundSelectorElement.addEventListener('change', () => { this.onBackgroundChange(); });

    this.selectedBackground = window.localStorage.getItem('background') || defaultBackground;
    this.backgroundList = {};
    fetch('backgrounds/backgrounds.json')
      .then(response => response.json())
      .then((backgrounds) => {
        this.backgroundList = backgrounds;
        Object.keys(backgrounds).forEach((background) => {
          const option = document.createElement('option');
          option.value = background;
          option.innerText = background;
          if (this.selectedBackground === background) {
            option.selected = true;
          }
          this.backgroundSelectorElement.appendChild(option);
        });
        this.dispatchEvent(new Event('selectionchange'));
      });
  }

  onBackgroundChange() {
    this.selectedBackground = this.backgroundSelectorElement.value;
    window.localStorage.setItem('background', this.selectedBackground);
    this.dispatchEvent(new Event('selectionchange'));
  }

  get backgroundPath() {
    return this.backgroundList[this.selectedBackground];
  }
}

/* eslint-disable import/no-unresolved */
/* eslint-enable */

/**
 * A false gamepad to be used in tests
 */
class MockGamepad {
  /**
   * @param {Object} profileDescription - The profile description to parse to determine the length
   * of the button and axes arrays
   * @param {string} handedness - The gamepad's handedness
   */
  constructor(profileDescription, handedness) {
    if (!profileDescription) {
      throw new Error('No profileDescription supplied');
    }

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.id = profileDescription.profileId;

    // Loop through the profile description to determine how many elements to put in the buttons
    // and axes arrays
    let maxButtonIndex = 0;
    let maxAxisIndex = 0;
    const layout = profileDescription.layouts[handedness];
    this.mapping = layout.mapping;
    Object.values(layout.components).forEach(({ gamepadIndices }) => {
      const {
        [Constants.ComponentProperty.BUTTON]: buttonIndex,
        [Constants.ComponentProperty.X_AXIS]: xAxisIndex,
        [Constants.ComponentProperty.Y_AXIS]: yAxisIndex
      } = gamepadIndices;

      if (buttonIndex !== undefined && buttonIndex > maxButtonIndex) {
        maxButtonIndex = buttonIndex;
      }

      if (xAxisIndex !== undefined && (xAxisIndex > maxAxisIndex)) {
        maxAxisIndex = xAxisIndex;
      }

      if (yAxisIndex !== undefined && (yAxisIndex > maxAxisIndex)) {
        maxAxisIndex = yAxisIndex;
      }
    });

    // Fill the axes array
    this.axes = [];
    while (this.axes.length <= maxAxisIndex) {
      this.axes.push(0);
    }

    // Fill the buttons array
    this.buttons = [];
    while (this.buttons.length <= maxButtonIndex) {
      this.buttons.push({
        value: 0,
        touched: false,
        pressed: false
      });
    }
  }
}

/**
 * A fake XRInputSource that can be used to initialize a MotionController
 */
class MockXRInputSource {
  /**
   * @param {Object} gamepad - The Gamepad object that provides the button and axis data
   * @param {string} handedness - The handedness to report
   */
  constructor(profiles, gamepad, handedness) {
    this.gamepad = gamepad;

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.handedness = handedness;
    this.profiles = Object.freeze(profiles);
  }
}

/* eslint-disable import/no-unresolved */

const three = {};
let canvasParentElement;
let vrProfilesElement;
let vrProfilesListElement;

let profileSelector;
let backgroundSelector;
let mockControllerModel;
let isImmersive = false;

/**
 * Adds the event handlers for VR motion controllers to load the assets on connection
 * and remove them on disconnection
 * @param {number} index
 */
function initializeVRController(index) {
  const vrControllerGrip = three.renderer.xr.getControllerGrip(index);

  vrControllerGrip.addEventListener('connected', async (event) => {
    const controllerModel = new ControllerModel();
    vrControllerGrip.add(controllerModel);

    let xrInputSource = event.data;

    vrProfilesListElement.innerHTML += `<li><b>${xrInputSource.handedness}:</b> [${xrInputSource.profiles}]</li>`;

    if (profileSelector.forceVRProfile) {
      xrInputSource = new MockXRInputSource(
        [profileSelector.profile.profileId], event.data.gamepad, event.data.handedness
      );
    }

    const motionController = await profileSelector.createMotionController(xrInputSource);
    await controllerModel.initialize(motionController);

    if (three.environmentMap) {
      controllerModel.environmentMap = three.environmentMap;
    }
  });

  vrControllerGrip.addEventListener('disconnected', () => {
    vrControllerGrip.remove(vrControllerGrip.children[0]);
  });

  three.scene.add(vrControllerGrip);

  const vrControllerTarget = three.renderer.xr.getController(index);

  vrControllerTarget.addEventListener('connected', () => {
    if (profileSelector.showTargetRay) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
      geometry.setAttribute('color', new Float32BufferAttribute([0.5, 0.5, 0.5, 0, 0, 0], 3));

      const material = new LineBasicMaterial({
        vertexColors: VertexColors,
        blending: AdditiveBlending
      });

      vrControllerTarget.add(new Line(geometry, material));
    }
  });

  vrControllerTarget.addEventListener('disconnected', () => {
    if (vrControllerTarget.children.length) {
      vrControllerTarget.remove(vrControllerTarget.children[0]);
    }
  });

  three.scene.add(vrControllerTarget);
}

/**
 * The three.js render loop (used instead of requestAnimationFrame to support XR)
 */
function render() {
  if (mockControllerModel) {
    if (isImmersive) {
      three.scene.remove(mockControllerModel);
    } else {
      three.scene.add(mockControllerModel);
      ManualControls.updateText();
    }
  }

  three.cameraControls.update();

  three.renderer.render(three.scene, three.camera);
}

/**
 * @description Event handler for window resizing.
 */
function onResize() {
  const width = canvasParentElement.clientWidth;
  const height = canvasParentElement.clientHeight;
  three.camera.aspect = width / height;
  three.camera.updateProjectionMatrix();
  three.renderer.setSize(width, height);
  three.cameraControls.update();
}

/**
 * Initializes the three.js resources needed for this page
 */
function initializeThree() {
  canvasParentElement = document.getElementById('modelViewer');
  const width = canvasParentElement.clientWidth;
  const height = canvasParentElement.clientHeight;

  vrProfilesElement = document.getElementById('vrProfiles');
  vrProfilesListElement = document.getElementById('vrProfilesList');

  // Set up the THREE.js infrastructure
  three.camera = new PerspectiveCamera(75, width / height, 0.01, 1000);
  three.camera.position.y = 0.5;
  three.scene = new Scene();
  three.scene.background = new Color(0x00aa44);
  three.renderer = new WebGLRenderer({ antialias: true });
  three.renderer.setSize(width, height);
  three.renderer.outputEncoding = sRGBEncoding;

  // Set up the controls for moving the scene around
  three.cameraControls = new OrbitControls(three.camera, three.renderer.domElement);
  three.cameraControls.enableDamping = true;
  three.cameraControls.minDistance = 0.05;
  three.cameraControls.maxDistance = 0.3;
  three.cameraControls.enablePan = false;
  three.cameraControls.update();

  // Add VR
  canvasParentElement.appendChild(VRButton.createButton(three.renderer));
  three.renderer.xr.enabled = true;
  three.renderer.xr.addEventListener('sessionstart', () => {
    vrProfilesElement.hidden = false;
    vrProfilesListElement.innerHTML = '';
    isImmersive = true;
  });
  three.renderer.xr.addEventListener('sessionend', () => { isImmersive = false; });
  initializeVRController(0);
  initializeVRController(1);

  // Add the THREE.js canvas to the page
  canvasParentElement.appendChild(three.renderer.domElement);
  window.addEventListener('resize', onResize, false);

  // Start pumping frames
  three.renderer.setAnimationLoop(render);
}

function onSelectionClear() {
  ManualControls.clear();
  if (mockControllerModel) {
    three.scene.remove(mockControllerModel);
    mockControllerModel = null;
  }
}

async function onSelectionChange() {
  onSelectionClear();
  const mockGamepad = new MockGamepad(profileSelector.profile, profileSelector.handedness);
  const mockXRInputSource = new MockXRInputSource(
    [profileSelector.profile.profileId], mockGamepad, profileSelector.handedness
  );
  mockControllerModel = new ControllerModel(mockXRInputSource);
  three.scene.add(mockControllerModel);

  const motionController = await profileSelector.createMotionController(mockXRInputSource);
  ManualControls.build(motionController);
  await mockControllerModel.initialize(motionController);

  if (three.environmentMap) {
    mockControllerModel.environmentMap = three.environmentMap;
  }
}

async function onBackgroundChange() {
  const pmremGenerator = new PMREMGenerator(three.renderer);
  pmremGenerator.compileEquirectangularShader();

  await new Promise((resolve) => {
    const rgbeLoader = new RGBELoader();
    rgbeLoader.setDataType(UnsignedByteType);
    rgbeLoader.setPath('backgrounds/');
    rgbeLoader.load(backgroundSelector.backgroundPath, (texture) => {
      three.environmentMap = pmremGenerator.fromEquirectangular(texture).texture;
      three.scene.background = three.environmentMap;

      if (mockControllerModel) {
        mockControllerModel.environmentMap = three.environmentMap;
      }

      pmremGenerator.dispose();
      resolve(three.environmentMap);
    });
  });
}

/**
 * Page load handler for initialzing things that depend on the DOM to be ready
 */
function onLoad() {
  AssetError.initialize();
  profileSelector = new ProfileSelector();
  initializeThree();

  profileSelector.addEventListener('selectionclear', onSelectionClear);
  profileSelector.addEventListener('selectionchange', onSelectionChange);

  backgroundSelector = new BackgroundSelector();
  backgroundSelector.addEventListener('selectionchange', onBackgroundChange);
}
window.addEventListener('load', onLoad);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9kZWxWaWV3ZXIuanMiLCJzb3VyY2VzIjpbIi4uL3NyYy9tYW51YWxDb250cm9scy5qcyIsIi4uL3NyYy9hc3NldEVycm9yLmpzIiwiLi4vc3JjL2NvbnRyb2xsZXJNb2RlbC5qcyIsIi4uL3NyYy9sb2NhbFByb2ZpbGUuanMiLCIuLi9zcmMvcHJvZmlsZVNlbGVjdG9yLmpzIiwiLi4vc3JjL2JhY2tncm91bmRTZWxlY3Rvci5qcyIsIi4uL3NyYy9tb2Nrcy9tb2NrR2FtZXBhZC5qcyIsIi4uL3NyYy9tb2Nrcy9tb2NrWFJJbnB1dFNvdXJjZS5qcyIsIi4uL3NyYy9tb2RlbFZpZXdlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJsZXQgbW90aW9uQ29udHJvbGxlcjtcclxubGV0IG1vY2tHYW1lcGFkO1xyXG5sZXQgY29udHJvbHNMaXN0RWxlbWVudDtcclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVRleHQoKSB7XHJcbiAgaWYgKG1vdGlvbkNvbnRyb2xsZXIpIHtcclxuICAgIE9iamVjdC52YWx1ZXMobW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcclxuICAgICAgY29uc3QgZGF0YUVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgJHtjb21wb25lbnQuaWR9X2RhdGFgKTtcclxuICAgICAgZGF0YUVsZW1lbnQuaW5uZXJIVE1MID0gSlNPTi5zdHJpbmdpZnkoY29tcG9uZW50LmRhdGEsIG51bGwsIDIpO1xyXG4gICAgfSk7XHJcbiAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBvbkJ1dHRvblZhbHVlQ2hhbmdlKGV2ZW50KSB7XHJcbiAgY29uc3QgeyBpbmRleCB9ID0gZXZlbnQudGFyZ2V0LmRhdGFzZXQ7XHJcbiAgbW9ja0dhbWVwYWQuYnV0dG9uc1tpbmRleF0udmFsdWUgPSBOdW1iZXIoZXZlbnQudGFyZ2V0LnZhbHVlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gb25BeGlzVmFsdWVDaGFuZ2UoZXZlbnQpIHtcclxuICBjb25zdCB7IGluZGV4IH0gPSBldmVudC50YXJnZXQuZGF0YXNldDtcclxuICBtb2NrR2FtZXBhZC5heGVzW2luZGV4XSA9IE51bWJlcihldmVudC50YXJnZXQudmFsdWUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGVhcigpIHtcclxuICBtb3Rpb25Db250cm9sbGVyID0gdW5kZWZpbmVkO1xyXG4gIG1vY2tHYW1lcGFkID0gdW5kZWZpbmVkO1xyXG5cclxuICBpZiAoIWNvbnRyb2xzTGlzdEVsZW1lbnQpIHtcclxuICAgIGNvbnRyb2xzTGlzdEVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29udHJvbHNMaXN0Jyk7XHJcbiAgfVxyXG4gIGNvbnRyb2xzTGlzdEVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFkZEJ1dHRvbkNvbnRyb2xzKGNvbXBvbmVudENvbnRyb2xzRWxlbWVudCwgYnV0dG9uSW5kZXgpIHtcclxuICBjb25zdCBidXR0b25Db250cm9sc0VsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICBidXR0b25Db250cm9sc0VsZW1lbnQuc2V0QXR0cmlidXRlKCdjbGFzcycsICdjb21wb25lbnRDb250cm9scycpO1xyXG5cclxuICBidXR0b25Db250cm9sc0VsZW1lbnQuaW5uZXJIVE1MICs9IGBcclxuICA8bGFiZWw+YnV0dG9uVmFsdWU8L2xhYmVsPlxyXG4gIDxpbnB1dCBpZD1cImJ1dHRvbnNbJHtidXR0b25JbmRleH1dLnZhbHVlXCIgZGF0YS1pbmRleD1cIiR7YnV0dG9uSW5kZXh9XCIgdHlwZT1cInJhbmdlXCIgbWluPVwiMFwiIG1heD1cIjFcIiBzdGVwPVwiMC4wMVwiIHZhbHVlPVwiMFwiPlxyXG4gIGA7XHJcblxyXG4gIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5hcHBlbmRDaGlsZChidXR0b25Db250cm9sc0VsZW1lbnQpO1xyXG5cclxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgYnV0dG9uc1ske2J1dHRvbkluZGV4fV0udmFsdWVgKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIG9uQnV0dG9uVmFsdWVDaGFuZ2UpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhZGRBeGlzQ29udHJvbHMoY29tcG9uZW50Q29udHJvbHNFbGVtZW50LCBheGlzTmFtZSwgYXhpc0luZGV4KSB7XHJcbiAgY29uc3QgYXhpc0NvbnRyb2xzRWxlbWVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gIGF4aXNDb250cm9sc0VsZW1lbnQuc2V0QXR0cmlidXRlKCdjbGFzcycsICdjb21wb25lbnRDb250cm9scycpO1xyXG5cclxuICBheGlzQ29udHJvbHNFbGVtZW50LmlubmVySFRNTCArPSBgXHJcbiAgPGxhYmVsPiR7YXhpc05hbWV9PGxhYmVsPlxyXG4gIDxpbnB1dCBpZD1cImF4ZXNbJHtheGlzSW5kZXh9XVwiIGRhdGEtaW5kZXg9XCIke2F4aXNJbmRleH1cIlxyXG4gICAgICAgICAgdHlwZT1cInJhbmdlXCIgbWluPVwiLTFcIiBtYXg9XCIxXCIgc3RlcD1cIjAuMDFcIiB2YWx1ZT1cIjBcIj5cclxuICBgO1xyXG5cclxuICBjb21wb25lbnRDb250cm9sc0VsZW1lbnQuYXBwZW5kQ2hpbGQoYXhpc0NvbnRyb2xzRWxlbWVudCk7XHJcblxyXG4gIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBheGVzWyR7YXhpc0luZGV4fV1gKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIG9uQXhpc1ZhbHVlQ2hhbmdlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYnVpbGQoc291cmNlTW90aW9uQ29udHJvbGxlcikge1xyXG4gIGNsZWFyKCk7XHJcblxyXG4gIG1vdGlvbkNvbnRyb2xsZXIgPSBzb3VyY2VNb3Rpb25Db250cm9sbGVyO1xyXG4gIG1vY2tHYW1lcGFkID0gbW90aW9uQ29udHJvbGxlci54cklucHV0U291cmNlLmdhbWVwYWQ7XHJcblxyXG4gIE9iamVjdC52YWx1ZXMobW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcclxuICAgIGNvbnN0IGNvbXBvbmVudENvbnRyb2xzRWxlbWVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xpJyk7XHJcbiAgICBjb21wb25lbnRDb250cm9sc0VsZW1lbnQuc2V0QXR0cmlidXRlKCdjbGFzcycsICdjb21wb25lbnQnKTtcclxuICAgIGNvbnRyb2xzTGlzdEVsZW1lbnQuYXBwZW5kQ2hpbGQoY29tcG9uZW50Q29udHJvbHNFbGVtZW50KTtcclxuXHJcbiAgICBjb25zdCBoZWFkaW5nRWxlbWVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2g0Jyk7XHJcbiAgICBoZWFkaW5nRWxlbWVudC5pbm5lclRleHQgPSBgJHtjb21wb25lbnQuaWR9YDtcclxuICAgIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5hcHBlbmRDaGlsZChoZWFkaW5nRWxlbWVudCk7XHJcblxyXG4gICAgaWYgKGNvbXBvbmVudC5nYW1lcGFkSW5kaWNlcy5idXR0b24gIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICBhZGRCdXR0b25Db250cm9scyhjb21wb25lbnRDb250cm9sc0VsZW1lbnQsIGNvbXBvbmVudC5nYW1lcGFkSW5kaWNlcy5idXR0b24pO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChjb21wb25lbnQuZ2FtZXBhZEluZGljZXMueEF4aXMgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICBhZGRBeGlzQ29udHJvbHMoY29tcG9uZW50Q29udHJvbHNFbGVtZW50LCAneEF4aXMnLCBjb21wb25lbnQuZ2FtZXBhZEluZGljZXMueEF4aXMpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChjb21wb25lbnQuZ2FtZXBhZEluZGljZXMueUF4aXMgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICBhZGRBeGlzQ29udHJvbHMoY29tcG9uZW50Q29udHJvbHNFbGVtZW50LCAneUF4aXMnLCBjb21wb25lbnQuZ2FtZXBhZEluZGljZXMueUF4aXMpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGRhdGFFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncHJlJyk7XHJcbiAgICBkYXRhRWxlbWVudC5pZCA9IGAke2NvbXBvbmVudC5pZH1fZGF0YWA7XHJcbiAgICBjb21wb25lbnRDb250cm9sc0VsZW1lbnQuYXBwZW5kQ2hpbGQoZGF0YUVsZW1lbnQpO1xyXG4gIH0pO1xyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCB7IGNsZWFyLCBidWlsZCwgdXBkYXRlVGV4dCB9O1xyXG4iLCJsZXQgZXJyb3JzU2VjdGlvbkVsZW1lbnQ7XHJcbmxldCBlcnJvcnNMaXN0RWxlbWVudDtcclxuY2xhc3MgQXNzZXRFcnJvciBleHRlbmRzIEVycm9yIHtcclxuICBjb25zdHJ1Y3RvciguLi5wYXJhbXMpIHtcclxuICAgIHN1cGVyKC4uLnBhcmFtcyk7XHJcbiAgICBBc3NldEVycm9yLmxvZyh0aGlzLm1lc3NhZ2UpO1xyXG4gIH1cclxuXHJcbiAgc3RhdGljIGluaXRpYWxpemUoKSB7XHJcbiAgICBlcnJvcnNMaXN0RWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvcnMnKTtcclxuICAgIGVycm9yc1NlY3Rpb25FbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9ycycpO1xyXG4gIH1cclxuXHJcbiAgc3RhdGljIGxvZyhlcnJvck1lc3NhZ2UpIHtcclxuICAgIGNvbnN0IGl0ZW1FbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGknKTtcclxuICAgIGl0ZW1FbGVtZW50LmlubmVyVGV4dCA9IGVycm9yTWVzc2FnZTtcclxuICAgIGVycm9yc0xpc3RFbGVtZW50LmFwcGVuZENoaWxkKGl0ZW1FbGVtZW50KTtcclxuICAgIGVycm9yc1NlY3Rpb25FbGVtZW50LmhpZGRlbiA9IGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgc3RhdGljIGNsZWFyQWxsKCkge1xyXG4gICAgZXJyb3JzTGlzdEVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XHJcbiAgICBlcnJvcnNTZWN0aW9uRWxlbWVudC5oaWRkZW4gPSB0cnVlO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGRlZmF1bHQgQXNzZXRFcnJvcjtcclxuIiwiLyogZXNsaW50LWRpc2FibGUgaW1wb3J0L25vLXVucmVzb2x2ZWQgKi9cclxuaW1wb3J0ICogYXMgVEhSRUUgZnJvbSAnLi90aHJlZS9idWlsZC90aHJlZS5tb2R1bGUuanMnO1xyXG5pbXBvcnQgeyBHTFRGTG9hZGVyIH0gZnJvbSAnLi90aHJlZS9leGFtcGxlcy9qc20vbG9hZGVycy9HTFRGTG9hZGVyLmpzJztcclxuaW1wb3J0IHsgQ29uc3RhbnRzIH0gZnJvbSAnLi9tb3Rpb24tY29udHJvbGxlcnMubW9kdWxlLmpzJztcclxuLyogZXNsaW50LWVuYWJsZSAqL1xyXG5cclxuaW1wb3J0IEFzc2V0RXJyb3IgZnJvbSAnLi9hc3NldEVycm9yLmpzJztcclxuXHJcbmNvbnN0IGdsdGZMb2FkZXIgPSBuZXcgR0xURkxvYWRlcigpO1xyXG5cclxuY2xhc3MgQ29udHJvbGxlck1vZGVsIGV4dGVuZHMgVEhSRUUuT2JqZWN0M0Qge1xyXG4gIGNvbnN0cnVjdG9yKCkge1xyXG4gICAgc3VwZXIoKTtcclxuICAgIHRoaXMueHJJbnB1dFNvdXJjZSA9IG51bGw7XHJcbiAgICB0aGlzLm1vdGlvbkNvbnRyb2xsZXIgPSBudWxsO1xyXG4gICAgdGhpcy5hc3NldCA9IG51bGw7XHJcbiAgICB0aGlzLnJvb3ROb2RlID0gbnVsbDtcclxuICAgIHRoaXMubm9kZXMgPSB7fTtcclxuICAgIHRoaXMubG9hZGVkID0gZmFsc2U7XHJcbiAgICB0aGlzLmVudk1hcCA9IG51bGw7XHJcbiAgfVxyXG5cclxuICBzZXQgZW52aXJvbm1lbnRNYXAodmFsdWUpIHtcclxuICAgIGlmICh0aGlzLmVudk1hcCA9PT0gdmFsdWUpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHRoaXMuZW52TWFwID0gdmFsdWU7XHJcbiAgICAvKiBlc2xpbnQtZGlzYWJsZSBuby1wYXJhbS1yZWFzc2lnbiAqL1xyXG4gICAgdGhpcy50cmF2ZXJzZSgoY2hpbGQpID0+IHtcclxuICAgICAgaWYgKGNoaWxkLmlzTWVzaCkge1xyXG4gICAgICAgIGNoaWxkLm1hdGVyaWFsLmVudk1hcCA9IHRoaXMuZW52TWFwO1xyXG4gICAgICAgIGNoaWxkLm1hdGVyaWFsLm5lZWRzVXBkYXRlID0gdHJ1ZTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICAvKiBlc2xpbnQtZW5hYmxlICovXHJcbiAgfVxyXG5cclxuICBnZXQgZW52aXJvbm1lbnRNYXAoKSB7XHJcbiAgICByZXR1cm4gdGhpcy5lbnZNYXA7XHJcbiAgfVxyXG5cclxuICBhc3luYyBpbml0aWFsaXplKG1vdGlvbkNvbnRyb2xsZXIpIHtcclxuICAgIHRoaXMubW90aW9uQ29udHJvbGxlciA9IG1vdGlvbkNvbnRyb2xsZXI7XHJcbiAgICB0aGlzLnhySW5wdXRTb3VyY2UgPSB0aGlzLm1vdGlvbkNvbnRyb2xsZXIueHJJbnB1dFNvdXJjZTtcclxuXHJcbiAgICAvLyBGZXRjaCB0aGUgYXNzZXRzIGFuZCBnZW5lcmF0ZSB0aHJlZWpzIG9iamVjdHMgZm9yIGl0XHJcbiAgICB0aGlzLmFzc2V0ID0gYXdhaXQgbmV3IFByb21pc2UoKChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgZ2x0ZkxvYWRlci5sb2FkKFxyXG4gICAgICAgIG1vdGlvbkNvbnRyb2xsZXIuYXNzZXRVcmwsXHJcbiAgICAgICAgKGxvYWRlZEFzc2V0KSA9PiB7IHJlc29sdmUobG9hZGVkQXNzZXQpOyB9LFxyXG4gICAgICAgIG51bGwsXHJcbiAgICAgICAgKCkgPT4geyByZWplY3QobmV3IEFzc2V0RXJyb3IoYEFzc2V0ICR7bW90aW9uQ29udHJvbGxlci5hc3NldFVybH0gbWlzc2luZyBvciBtYWxmb3JtZWQuYCkpOyB9XHJcbiAgICAgICk7XHJcbiAgICB9KSk7XHJcblxyXG4gICAgaWYgKHRoaXMuZW52TWFwKSB7XHJcbiAgICAgIC8qIGVzbGludC1kaXNhYmxlIG5vLXBhcmFtLXJlYXNzaWduICovXHJcbiAgICAgIHRoaXMuYXNzZXQuc2NlbmUudHJhdmVyc2UoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgaWYgKGNoaWxkLmlzTWVzaCkge1xyXG4gICAgICAgICAgY2hpbGQubWF0ZXJpYWwuZW52TWFwID0gdGhpcy5lbnZNYXA7XHJcbiAgICAgICAgfVxyXG4gICAgICB9KTtcclxuICAgICAgLyogZXNsaW50LWVuYWJsZSAqL1xyXG4gICAgfVxyXG5cclxuICAgIHRoaXMucm9vdE5vZGUgPSB0aGlzLmFzc2V0LnNjZW5lO1xyXG4gICAgdGhpcy5hZGRUb3VjaERvdHMoKTtcclxuICAgIHRoaXMuZmluZE5vZGVzKCk7XHJcbiAgICB0aGlzLmFkZCh0aGlzLnJvb3ROb2RlKTtcclxuICAgIHRoaXMubG9hZGVkID0gdHJ1ZTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFBvbGxzIGRhdGEgZnJvbSB0aGUgWFJJbnB1dFNvdXJjZSBhbmQgdXBkYXRlcyB0aGUgbW9kZWwncyBjb21wb25lbnRzIHRvIG1hdGNoXHJcbiAgICogdGhlIHJlYWwgd29ybGQgZGF0YVxyXG4gICAqL1xyXG4gIHVwZGF0ZU1hdHJpeFdvcmxkKGZvcmNlKSB7XHJcbiAgICBzdXBlci51cGRhdGVNYXRyaXhXb3JsZChmb3JjZSk7XHJcblxyXG4gICAgaWYgKCF0aGlzLmxvYWRlZCkge1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ2F1c2UgdGhlIE1vdGlvbkNvbnRyb2xsZXIgdG8gcG9sbCB0aGUgR2FtZXBhZCBmb3IgZGF0YVxyXG4gICAgdGhpcy5tb3Rpb25Db250cm9sbGVyLnVwZGF0ZUZyb21HYW1lcGFkKCk7XHJcblxyXG4gICAgLy8gVXBkYXRlIHRoZSAzRCBtb2RlbCB0byByZWZsZWN0IHRoZSBidXR0b24sIHRodW1ic3RpY2ssIGFuZCB0b3VjaHBhZCBzdGF0ZVxyXG4gICAgT2JqZWN0LnZhbHVlcyh0aGlzLm1vdGlvbkNvbnRyb2xsZXIuY29tcG9uZW50cykuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XHJcbiAgICAgIC8vIFVwZGF0ZSBub2RlIGRhdGEgYmFzZWQgb24gdGhlIHZpc3VhbCByZXNwb25zZXMnIGN1cnJlbnQgc3RhdGVzXHJcbiAgICAgIE9iamVjdC52YWx1ZXMoY29tcG9uZW50LnZpc3VhbFJlc3BvbnNlcykuZm9yRWFjaCgodmlzdWFsUmVzcG9uc2UpID0+IHtcclxuICAgICAgICBjb25zdCB7XHJcbiAgICAgICAgICB2YWx1ZU5vZGVOYW1lLCBtaW5Ob2RlTmFtZSwgbWF4Tm9kZU5hbWUsIHZhbHVlLCB2YWx1ZU5vZGVQcm9wZXJ0eVxyXG4gICAgICAgIH0gPSB2aXN1YWxSZXNwb25zZTtcclxuICAgICAgICBjb25zdCB2YWx1ZU5vZGUgPSB0aGlzLm5vZGVzW3ZhbHVlTm9kZU5hbWVdO1xyXG5cclxuICAgICAgICAvLyBTa2lwIGlmIHRoZSB2aXN1YWwgcmVzcG9uc2Ugbm9kZSBpcyBub3QgZm91bmQuIE5vIGVycm9yIGlzIG5lZWRlZCxcclxuICAgICAgICAvLyBiZWNhdXNlIGl0IHdpbGwgaGF2ZSBiZWVuIHJlcG9ydGVkIGF0IGxvYWQgdGltZS5cclxuICAgICAgICBpZiAoIXZhbHVlTm9kZSkgcmV0dXJuO1xyXG5cclxuICAgICAgICAvLyBDYWxjdWxhdGUgdGhlIG5ldyBwcm9wZXJ0aWVzIGJhc2VkIG9uIHRoZSB3ZWlnaHQgc3VwcGxpZWRcclxuICAgICAgICBpZiAodmFsdWVOb2RlUHJvcGVydHkgPT09IENvbnN0YW50cy5WaXN1YWxSZXNwb25zZVByb3BlcnR5LlZJU0lCSUxJVFkpIHtcclxuICAgICAgICAgIHZhbHVlTm9kZS52aXNpYmxlID0gdmFsdWU7XHJcbiAgICAgICAgfSBlbHNlIGlmICh2YWx1ZU5vZGVQcm9wZXJ0eSA9PT0gQ29uc3RhbnRzLlZpc3VhbFJlc3BvbnNlUHJvcGVydHkuVFJBTlNGT1JNKSB7XHJcbiAgICAgICAgICBjb25zdCBtaW5Ob2RlID0gdGhpcy5ub2Rlc1ttaW5Ob2RlTmFtZV07XHJcbiAgICAgICAgICBjb25zdCBtYXhOb2RlID0gdGhpcy5ub2Rlc1ttYXhOb2RlTmFtZV07XHJcbiAgICAgICAgICB2YWx1ZU5vZGUucXVhdGVybmlvbi5zbGVycFF1YXRlcm5pb25zKFxyXG4gICAgICAgICAgICBtaW5Ob2RlLnF1YXRlcm5pb24sXHJcbiAgICAgICAgICAgIG1heE5vZGUucXVhdGVybmlvbixcclxuICAgICAgICAgICAgdmFsdWVcclxuICAgICAgICAgICk7XHJcblxyXG4gICAgICAgICAgdmFsdWVOb2RlLnBvc2l0aW9uLmxlcnBWZWN0b3JzKFxyXG4gICAgICAgICAgICBtaW5Ob2RlLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICBtYXhOb2RlLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICB2YWx1ZVxyXG4gICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBXYWxrcyB0aGUgbW9kZWwncyB0cmVlIHRvIGZpbmQgdGhlIG5vZGVzIG5lZWRlZCB0byBhbmltYXRlIHRoZSBjb21wb25lbnRzIGFuZFxyXG4gICAqIHNhdmVzIHRoZW0gZm9yIHVzZSBpbiB0aGUgZnJhbWUgbG9vcFxyXG4gICAqL1xyXG4gIGZpbmROb2RlcygpIHtcclxuICAgIHRoaXMubm9kZXMgPSB7fTtcclxuXHJcbiAgICAvLyBMb29wIHRocm91Z2ggdGhlIGNvbXBvbmVudHMgYW5kIGZpbmQgdGhlIG5vZGVzIG5lZWRlZCBmb3IgZWFjaCBjb21wb25lbnRzJyB2aXN1YWwgcmVzcG9uc2VzXHJcbiAgICBPYmplY3QudmFsdWVzKHRoaXMubW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcclxuICAgICAgY29uc3QgeyB0b3VjaFBvaW50Tm9kZU5hbWUsIHZpc3VhbFJlc3BvbnNlcyB9ID0gY29tcG9uZW50O1xyXG4gICAgICBpZiAodG91Y2hQb2ludE5vZGVOYW1lKSB7XHJcbiAgICAgICAgdGhpcy5ub2Rlc1t0b3VjaFBvaW50Tm9kZU5hbWVdID0gdGhpcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUodG91Y2hQb2ludE5vZGVOYW1lKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gTG9vcCB0aHJvdWdoIGFsbCB0aGUgdmlzdWFsIHJlc3BvbnNlcyB0byBiZSBhcHBsaWVkIHRvIHRoaXMgY29tcG9uZW50XHJcbiAgICAgIE9iamVjdC52YWx1ZXModmlzdWFsUmVzcG9uc2VzKS5mb3JFYWNoKCh2aXN1YWxSZXNwb25zZSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHtcclxuICAgICAgICAgIHZhbHVlTm9kZU5hbWUsIG1pbk5vZGVOYW1lLCBtYXhOb2RlTmFtZSwgdmFsdWVOb2RlUHJvcGVydHlcclxuICAgICAgICB9ID0gdmlzdWFsUmVzcG9uc2U7XHJcbiAgICAgICAgLy8gSWYgYW5pbWF0aW5nIGEgdHJhbnNmb3JtLCBmaW5kIHRoZSB0d28gbm9kZXMgdG8gYmUgaW50ZXJwb2xhdGVkIGJldHdlZW4uXHJcbiAgICAgICAgaWYgKHZhbHVlTm9kZVByb3BlcnR5ID09PSBDb25zdGFudHMuVmlzdWFsUmVzcG9uc2VQcm9wZXJ0eS5UUkFOU0ZPUk0pIHtcclxuICAgICAgICAgIHRoaXMubm9kZXNbbWluTm9kZU5hbWVdID0gdGhpcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUobWluTm9kZU5hbWUpO1xyXG4gICAgICAgICAgdGhpcy5ub2Rlc1ttYXhOb2RlTmFtZV0gPSB0aGlzLnJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZShtYXhOb2RlTmFtZSk7XHJcblxyXG4gICAgICAgICAgLy8gSWYgdGhlIGV4dGVudHMgY2Fubm90IGJlIGZvdW5kLCBza2lwIHRoaXMgYW5pbWF0aW9uXHJcbiAgICAgICAgICBpZiAoIXRoaXMubm9kZXNbbWluTm9kZU5hbWVdKSB7XHJcbiAgICAgICAgICAgIEFzc2V0RXJyb3IubG9nKGBDb3VsZCBub3QgZmluZCAke21pbk5vZGVOYW1lfSBpbiB0aGUgbW9kZWxgKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgaWYgKCF0aGlzLm5vZGVzW21heE5vZGVOYW1lXSkge1xyXG4gICAgICAgICAgICBBc3NldEVycm9yLmxvZyhgQ291bGQgbm90IGZpbmQgJHttYXhOb2RlTmFtZX0gaW4gdGhlIG1vZGVsYCk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIElmIHRoZSB0YXJnZXQgbm9kZSBjYW5ub3QgYmUgZm91bmQsIHNraXAgdGhpcyBhbmltYXRpb25cclxuICAgICAgICB0aGlzLm5vZGVzW3ZhbHVlTm9kZU5hbWVdID0gdGhpcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUodmFsdWVOb2RlTmFtZSk7XHJcbiAgICAgICAgaWYgKCF0aGlzLm5vZGVzW3ZhbHVlTm9kZU5hbWVdKSB7XHJcbiAgICAgICAgICBBc3NldEVycm9yLmxvZyhgQ291bGQgbm90IGZpbmQgJHt2YWx1ZU5vZGVOYW1lfSBpbiB0aGUgbW9kZWxgKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBBZGQgdG91Y2ggZG90cyB0byBhbGwgdG91Y2hwYWQgY29tcG9uZW50cyBzbyB0aGUgZmluZ2VyIGNhbiBiZSBzZWVuXHJcbiAgICovXHJcbiAgYWRkVG91Y2hEb3RzKCkge1xyXG4gICAgT2JqZWN0LmtleXModGhpcy5tb3Rpb25Db250cm9sbGVyLmNvbXBvbmVudHMpLmZvckVhY2goKGNvbXBvbmVudElkKSA9PiB7XHJcbiAgICAgIGNvbnN0IGNvbXBvbmVudCA9IHRoaXMubW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzW2NvbXBvbmVudElkXTtcclxuICAgICAgLy8gRmluZCB0aGUgdG91Y2hwYWRzXHJcbiAgICAgIGlmIChjb21wb25lbnQudHlwZSA9PT0gQ29uc3RhbnRzLkNvbXBvbmVudFR5cGUuVE9VQ0hQQUQpIHtcclxuICAgICAgICAvLyBGaW5kIHRoZSBub2RlIHRvIGF0dGFjaCB0aGUgdG91Y2ggZG90LlxyXG4gICAgICAgIGNvbnN0IHRvdWNoUG9pbnRSb290ID0gdGhpcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUoY29tcG9uZW50LnRvdWNoUG9pbnROb2RlTmFtZSwgdHJ1ZSk7XHJcbiAgICAgICAgaWYgKCF0b3VjaFBvaW50Um9vdCkge1xyXG4gICAgICAgICAgQXNzZXRFcnJvci5sb2coYENvdWxkIG5vdCBmaW5kIHRvdWNoIGRvdCwgJHtjb21wb25lbnQudG91Y2hQb2ludE5vZGVOYW1lfSwgaW4gdG91Y2hwYWQgY29tcG9uZW50ICR7Y29tcG9uZW50SWR9YCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgIGNvbnN0IHNwaGVyZUdlb21ldHJ5ID0gbmV3IFRIUkVFLlNwaGVyZUdlb21ldHJ5KDAuMDAxKTtcclxuICAgICAgICAgIGNvbnN0IG1hdGVyaWFsID0gbmV3IFRIUkVFLk1lc2hCYXNpY01hdGVyaWFsKHsgY29sb3I6IDB4MDAwMEZGIH0pO1xyXG4gICAgICAgICAgY29uc3Qgc3BoZXJlID0gbmV3IFRIUkVFLk1lc2goc3BoZXJlR2VvbWV0cnksIG1hdGVyaWFsKTtcclxuICAgICAgICAgIHRvdWNoUG9pbnRSb290LmFkZChzcGhlcmUpO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBDb250cm9sbGVyTW9kZWw7XHJcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXHJcbmltcG9ydCAnLi9hanYvYWp2Lm1pbi5qcyc7XHJcbmltcG9ydCB2YWxpZGF0ZVJlZ2lzdHJ5UHJvZmlsZSBmcm9tICcuL3JlZ2lzdHJ5VG9vbHMvdmFsaWRhdGVSZWdpc3RyeVByb2ZpbGUuanMnO1xyXG5pbXBvcnQgZXhwYW5kUmVnaXN0cnlQcm9maWxlIGZyb20gJy4vYXNzZXRUb29scy9leHBhbmRSZWdpc3RyeVByb2ZpbGUuanMnO1xyXG5pbXBvcnQgYnVpbGRBc3NldFByb2ZpbGUgZnJvbSAnLi9hc3NldFRvb2xzL2J1aWxkQXNzZXRQcm9maWxlLmpzJztcclxuLyogZXNsaW50LWVuYWJsZSAqL1xyXG5cclxuaW1wb3J0IEFzc2V0RXJyb3IgZnJvbSAnLi9hc3NldEVycm9yLmpzJztcclxuXHJcbi8qKlxyXG4gKiBMb2FkcyBhIHByb2ZpbGUgZnJvbSBhIHNldCBvZiBsb2NhbCBmaWxlc1xyXG4gKi9cclxuY2xhc3MgTG9jYWxQcm9maWxlIGV4dGVuZHMgRXZlbnRUYXJnZXQge1xyXG4gIGNvbnN0cnVjdG9yKCkge1xyXG4gICAgc3VwZXIoKTtcclxuXHJcbiAgICB0aGlzLmxvY2FsRmlsZXNMaXN0RWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NhbEZpbGVzTGlzdCcpO1xyXG4gICAgdGhpcy5maWxlc1NlbGVjdG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsRmlsZXNTZWxlY3RvcicpO1xyXG4gICAgdGhpcy5maWxlc1NlbGVjdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcclxuICAgICAgdGhpcy5vbkZpbGVzU2VsZWN0ZWQoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHRoaXMuY2xlYXIoKTtcclxuXHJcbiAgICBMb2NhbFByb2ZpbGUuYnVpbGRTY2hlbWFWYWxpZGF0b3IoJ3JlZ2lzdHJ5VG9vbHMvcmVnaXN0cnlTY2hlbWFzLmpzb24nKS50aGVuKChyZWdpc3RyeVNjaGVtYVZhbGlkYXRvcikgPT4ge1xyXG4gICAgICB0aGlzLnJlZ2lzdHJ5U2NoZW1hVmFsaWRhdG9yID0gcmVnaXN0cnlTY2hlbWFWYWxpZGF0b3I7XHJcbiAgICAgIExvY2FsUHJvZmlsZS5idWlsZFNjaGVtYVZhbGlkYXRvcignYXNzZXRUb29scy9hc3NldFNjaGVtYXMuanNvbicpLnRoZW4oKGFzc2V0U2NoZW1hVmFsaWRhdG9yKSA9PiB7XHJcbiAgICAgICAgdGhpcy5hc3NldFNjaGVtYVZhbGlkYXRvciA9IGFzc2V0U2NoZW1hVmFsaWRhdG9yO1xyXG4gICAgICAgIGNvbnN0IGR1cmluZ1BhZ2VMb2FkID0gdHJ1ZTtcclxuICAgICAgICB0aGlzLm9uRmlsZXNTZWxlY3RlZChkdXJpbmdQYWdlTG9hZCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBDbGVhcnMgYWxsIGxvY2FsIHByb2ZpbGUgaW5mb3JtYXRpb25cclxuICAgKi9cclxuICBjbGVhcigpIHtcclxuICAgIGlmICh0aGlzLnByb2ZpbGUpIHtcclxuICAgICAgdGhpcy5wcm9maWxlID0gbnVsbDtcclxuICAgICAgdGhpcy5wcm9maWxlSWQgPSBudWxsO1xyXG4gICAgICB0aGlzLmFzc2V0cyA9IFtdO1xyXG4gICAgICB0aGlzLmxvY2FsRmlsZXNMaXN0RWxlbWVudC5pbm5lckhUTUwgPSAnJztcclxuXHJcbiAgICAgIGNvbnN0IGNoYW5nZUV2ZW50ID0gbmV3IEV2ZW50KCdsb2NhbFByb2ZpbGVDaGFuZ2UnKTtcclxuICAgICAgdGhpcy5kaXNwYXRjaEV2ZW50KGNoYW5nZUV2ZW50KTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFByb2Nlc3NlcyBzZWxlY3RlZCBmaWxlcyBhbmQgZ2VuZXJhdGVzIGFuIGFzc2V0IHByb2ZpbGVcclxuICAgKiBAcGFyYW0ge2Jvb2xlYW59IGR1cmluZ1BhZ2VMb2FkXHJcbiAgICovXHJcbiAgYXN5bmMgb25GaWxlc1NlbGVjdGVkKGR1cmluZ1BhZ2VMb2FkKSB7XHJcbiAgICB0aGlzLmNsZWFyKCk7XHJcblxyXG4gICAgLy8gU2tpcCBpZiBpbml0aWFsemF0aW9uIGlzIGluY29tcGxldGVcclxuICAgIGlmICghdGhpcy5hc3NldFNjaGVtYVZhbGlkYXRvcikge1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgLy8gRXhhbWluZSB0aGUgZmlsZXMgc2VsZWN0ZWQgdG8gZmluZCB0aGUgcmVnaXN0cnkgcHJvZmlsZSwgYXNzZXQgb3ZlcnJpZGVzLCBhbmQgYXNzZXQgZmlsZXNcclxuICAgIGNvbnN0IGFzc2V0cyA9IFtdO1xyXG4gICAgbGV0IGFzc2V0SnNvbkZpbGU7XHJcbiAgICBsZXQgcmVnaXN0cnlKc29uRmlsZTtcclxuXHJcbiAgICBjb25zdCBmaWxlc0xpc3QgPSBBcnJheS5mcm9tKHRoaXMuZmlsZXNTZWxlY3Rvci5maWxlcyk7XHJcbiAgICBmaWxlc0xpc3QuZm9yRWFjaCgoZmlsZSkgPT4ge1xyXG4gICAgICBpZiAoZmlsZS5uYW1lLmVuZHNXaXRoKCcuZ2xiJykpIHtcclxuICAgICAgICBhc3NldHNbZmlsZS5uYW1lXSA9IHdpbmRvdy5VUkwuY3JlYXRlT2JqZWN0VVJMKGZpbGUpO1xyXG4gICAgICB9IGVsc2UgaWYgKGZpbGUubmFtZSA9PT0gJ3Byb2ZpbGUuanNvbicpIHtcclxuICAgICAgICBhc3NldEpzb25GaWxlID0gZmlsZTtcclxuICAgICAgfSBlbHNlIGlmIChmaWxlLm5hbWUuZW5kc1dpdGgoJy5qc29uJykpIHtcclxuICAgICAgICByZWdpc3RyeUpzb25GaWxlID0gZmlsZTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gTGlzdCB0aGUgZmlsZXMgZm91bmRcclxuICAgICAgdGhpcy5sb2NhbEZpbGVzTGlzdEVsZW1lbnQuaW5uZXJIVE1MICs9IGBcclxuICAgICAgICA8bGk+JHtmaWxlLm5hbWV9PC9saT5cclxuICAgICAgYDtcclxuICAgIH0pO1xyXG5cclxuICAgIGlmICghcmVnaXN0cnlKc29uRmlsZSkge1xyXG4gICAgICBBc3NldEVycm9yLmxvZygnTm8gcmVnaXN0cnkgcHJvZmlsZSBzZWxlY3RlZCcpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgYXdhaXQgdGhpcy5idWlsZFByb2ZpbGUocmVnaXN0cnlKc29uRmlsZSwgYXNzZXRKc29uRmlsZSwgYXNzZXRzKTtcclxuICAgIHRoaXMuYXNzZXRzID0gYXNzZXRzO1xyXG5cclxuICAgIC8vIENoYW5nZSB0aGUgc2VsZWN0ZWQgcHJvZmlsZSB0byB0aGUgb25lIGp1c3QgbG9hZGVkLiAgRG8gbm90IGRvIHRoaXMgb24gaW5pdGlhbCBwYWdlIGxvYWRcclxuICAgIC8vIGJlY2F1c2UgdGhlIHNlbGVjdGVkIGZpbGVzIHBlcnNpc3RzIGluIGZpcmVmb3ggYWNyb3NzIHJlZnJlc2hlcywgYnV0IHRoZSB1c2VyIG1heSBoYXZlXHJcbiAgICAvLyBzZWxlY3RlZCBhIGRpZmZlcmVudCBpdGVtIGZyb20gdGhlIGRyb3Bkb3duXHJcbiAgICBpZiAoIWR1cmluZ1BhZ2VMb2FkKSB7XHJcbiAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbSgncHJvZmlsZUlkJywgdGhpcy5wcm9maWxlSWQpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIE5vdGlmeSB0aGF0IHRoZSBsb2NhbCBwcm9maWxlIGlzIHJlYWR5IGZvciB1c2VcclxuICAgIGNvbnN0IGNoYW5nZUV2ZW50ID0gbmV3IEV2ZW50KCdsb2NhbHByb2ZpbGVjaGFuZ2UnKTtcclxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjaGFuZ2VFdmVudCk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBCdWlsZCBhIG1lcmdlZCBwcm9maWxlIGZpbGUgZnJvbSB0aGUgcmVnaXN0cnkgcHJvZmlsZSBhbmQgYXNzZXQgb3ZlcnJpZGVzXHJcbiAgICogQHBhcmFtIHsqfSByZWdpc3RyeUpzb25GaWxlXHJcbiAgICogQHBhcmFtIHsqfSBhc3NldEpzb25GaWxlXHJcbiAgICovXHJcbiAgYXN5bmMgYnVpbGRQcm9maWxlKHJlZ2lzdHJ5SnNvbkZpbGUsIGFzc2V0SnNvbkZpbGUpIHtcclxuICAgIC8vIExvYWQgdGhlIHJlZ2lzdHJ5IEpTT04gYW5kIHZhbGlkYXRlIGl0IGFnYWluc3QgdGhlIHNjaGVtYVxyXG4gICAgY29uc3QgcmVnaXN0cnlKc29uID0gYXdhaXQgTG9jYWxQcm9maWxlLmxvYWRMb2NhbEpzb24ocmVnaXN0cnlKc29uRmlsZSk7XHJcbiAgICBjb25zdCBpc1JlZ2lzdHJ5SnNvblZhbGlkID0gdGhpcy5yZWdpc3RyeVNjaGVtYVZhbGlkYXRvcihyZWdpc3RyeUpzb24pO1xyXG4gICAgaWYgKCFpc1JlZ2lzdHJ5SnNvblZhbGlkKSB7XHJcbiAgICAgIHRocm93IG5ldyBBc3NldEVycm9yKEpTT04uc3RyaW5naWZ5KHRoaXMucmVnaXN0cnlTY2hlbWFWYWxpZGF0b3IuZXJyb3JzLCBudWxsLCAyKSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gTG9hZCB0aGUgYXNzZXQgSlNPTiBhbmQgdmFsaWRhdGUgaXQgYWdhaW5zdCB0aGUgc2NoZW1hLlxyXG4gICAgLy8gSWYgbm8gYXNzZXQgSlNPTiBwcmVzZW50LCB1c2UgdGhlIGRlZmF1bHQgZGVmaW5pdG9uXHJcbiAgICBsZXQgYXNzZXRKc29uO1xyXG4gICAgaWYgKCFhc3NldEpzb25GaWxlKSB7XHJcbiAgICAgIGFzc2V0SnNvbiA9IHsgcHJvZmlsZUlkOiByZWdpc3RyeUpzb24ucHJvZmlsZUlkLCBvdmVycmlkZXM6IHt9IH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBhc3NldEpzb24gPSBhd2FpdCBMb2NhbFByb2ZpbGUubG9hZExvY2FsSnNvbihhc3NldEpzb25GaWxlKTtcclxuICAgICAgY29uc3QgaXNBc3NldEpzb25WYWxpZCA9IHRoaXMuYXNzZXRTY2hlbWFWYWxpZGF0b3IoYXNzZXRKc29uKTtcclxuICAgICAgaWYgKCFpc0Fzc2V0SnNvblZhbGlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEFzc2V0RXJyb3IoSlNPTi5zdHJpbmdpZnkodGhpcy5hc3NldFNjaGVtYVZhbGlkYXRvci5lcnJvcnMsIG51bGwsIDIpKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8vIFZhbGlkYXRlIG5vbi1zY2hlbWEgcmVxdWlyZW1lbnRzIGFuZCBidWlsZCBhIGNvbWJpbmVkIHByb2ZpbGVcclxuICAgIHZhbGlkYXRlUmVnaXN0cnlQcm9maWxlKHJlZ2lzdHJ5SnNvbik7XHJcbiAgICBjb25zdCBleHBhbmRlZFJlZ2lzdHJ5UHJvZmlsZSA9IGV4cGFuZFJlZ2lzdHJ5UHJvZmlsZShyZWdpc3RyeUpzb24pO1xyXG4gICAgdGhpcy5wcm9maWxlID0gYnVpbGRBc3NldFByb2ZpbGUoYXNzZXRKc29uLCBleHBhbmRlZFJlZ2lzdHJ5UHJvZmlsZSk7XHJcbiAgICB0aGlzLnByb2ZpbGVJZCA9IHRoaXMucHJvZmlsZS5wcm9maWxlSWQ7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBIZWxwZXIgdG8gbG9hZCBKU09OIGZyb20gYSBsb2NhbCBmaWxlXHJcbiAgICogQHBhcmFtIHtGaWxlfSBqc29uRmlsZVxyXG4gICAqL1xyXG4gIHN0YXRpYyBsb2FkTG9jYWxKc29uKGpzb25GaWxlKSB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCByZWFkZXIgPSBuZXcgRmlsZVJlYWRlcigpO1xyXG5cclxuICAgICAgcmVhZGVyLm9ubG9hZCA9ICgpID0+IHtcclxuICAgICAgICBjb25zdCBqc29uID0gSlNPTi5wYXJzZShyZWFkZXIucmVzdWx0KTtcclxuICAgICAgICByZXNvbHZlKGpzb24pO1xyXG4gICAgICB9O1xyXG5cclxuICAgICAgcmVhZGVyLm9uZXJyb3IgPSAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFVuYWJsZSB0byBsb2FkIEpTT04gZnJvbSAke2pzb25GaWxlLm5hbWV9YDtcclxuICAgICAgICBBc3NldEVycm9yLmxvZyhlcnJvck1lc3NhZ2UpO1xyXG4gICAgICAgIHJlamVjdChlcnJvck1lc3NhZ2UpO1xyXG4gICAgICB9O1xyXG5cclxuICAgICAgcmVhZGVyLnJlYWRBc1RleHQoanNvbkZpbGUpO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBIZWxwZXIgdG8gbG9hZCB0aGUgY29tYmluZWQgc2NoZW1hIGZpbGUgYW5kIGNvbXBpbGUgYW4gQUpWIHZhbGlkYXRvclxyXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBzY2hlbWFzUGF0aFxyXG4gICAqL1xyXG4gIHN0YXRpYyBhc3luYyBidWlsZFNjaGVtYVZhbGlkYXRvcihzY2hlbWFzUGF0aCkge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChzY2hlbWFzUGF0aCk7XHJcbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XHJcbiAgICAgIHRocm93IG5ldyBBc3NldEVycm9yKHJlc3BvbnNlLnN0YXR1c1RleHQpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby11bmRlZlxyXG4gICAgY29uc3QgYWp2ID0gbmV3IEFqdigpO1xyXG4gICAgY29uc3Qgc2NoZW1hcyA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcclxuICAgIHNjaGVtYXMuZGVwZW5kZW5jaWVzLmZvckVhY2goKHNjaGVtYSkgPT4ge1xyXG4gICAgICBhanYuYWRkU2NoZW1hKHNjaGVtYSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICByZXR1cm4gYWp2LmNvbXBpbGUoc2NoZW1hcy5tYWluU2NoZW1hKTtcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IExvY2FsUHJvZmlsZTtcclxuIiwiLyogZXNsaW50LWRpc2FibGUgaW1wb3J0L25vLXVucmVzb2x2ZWQgKi9cclxuaW1wb3J0IHsgZmV0Y2hQcm9maWxlLCBmZXRjaFByb2ZpbGVzTGlzdCwgTW90aW9uQ29udHJvbGxlciB9IGZyb20gJy4vbW90aW9uLWNvbnRyb2xsZXJzLm1vZHVsZS5qcyc7XHJcbi8qIGVzbGludC1lbmFibGUgKi9cclxuXHJcbmltcG9ydCBBc3NldEVycm9yIGZyb20gJy4vYXNzZXRFcnJvci5qcyc7XHJcbmltcG9ydCBMb2NhbFByb2ZpbGUgZnJvbSAnLi9sb2NhbFByb2ZpbGUuanMnO1xyXG5cclxuY29uc3QgcHJvZmlsZXNCYXNlUGF0aCA9ICcuL3Byb2ZpbGVzJztcclxuXHJcbi8qKlxyXG4gKiBMb2FkcyBwcm9maWxlcyBmcm9tIHRoZSBkaXN0cmlidXRpb24gZm9sZGVyIG5leHQgdG8gdGhlIHZpZXdlcidzIGxvY2F0aW9uXHJcbiAqL1xyXG5jbGFzcyBQcm9maWxlU2VsZWN0b3IgZXh0ZW5kcyBFdmVudFRhcmdldCB7XHJcbiAgY29uc3RydWN0b3IoKSB7XHJcbiAgICBzdXBlcigpO1xyXG5cclxuICAgIC8vIEdldCB0aGUgcHJvZmlsZSBpZCBzZWxlY3RvciBhbmQgbGlzdGVuIGZvciBjaGFuZ2VzXHJcbiAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlSWRTZWxlY3RvcicpO1xyXG4gICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyB0aGlzLm9uUHJvZmlsZUlkQ2hhbmdlKCk7IH0pO1xyXG5cclxuICAgIC8vIEdldCB0aGUgaGFuZGVkbmVzcyBzZWxlY3RvciBhbmQgbGlzdGVuIGZvciBjaGFuZ2VzXHJcbiAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFuZGVkbmVzc1NlbGVjdG9yJyk7XHJcbiAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyB0aGlzLm9uSGFuZGVkbmVzc0NoYW5nZSgpOyB9KTtcclxuXHJcbiAgICB0aGlzLmZvcmNlVlJQcm9maWxlRWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmb3JjZVZSUHJvZmlsZScpO1xyXG4gICAgdGhpcy5zaG93VGFyZ2V0UmF5RWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzaG93VGFyZ2V0UmF5Jyk7XHJcblxyXG4gICAgdGhpcy5sb2NhbFByb2ZpbGUgPSBuZXcgTG9jYWxQcm9maWxlKCk7XHJcbiAgICB0aGlzLmxvY2FsUHJvZmlsZS5hZGRFdmVudExpc3RlbmVyKCdsb2NhbHByb2ZpbGVjaGFuZ2UnLCAoZXZlbnQpID0+IHsgdGhpcy5vbkxvY2FsUHJvZmlsZUNoYW5nZShldmVudCk7IH0pO1xyXG5cclxuICAgIHRoaXMucHJvZmlsZXNMaXN0ID0gbnVsbDtcclxuICAgIHRoaXMucG9wdWxhdGVQcm9maWxlU2VsZWN0b3IoKTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFJlc2V0cyBhbGwgc2VsZWN0ZWQgcHJvZmlsZSBzdGF0ZVxyXG4gICAqL1xyXG4gIGNsZWFyU2VsZWN0ZWRQcm9maWxlKCkge1xyXG4gICAgQXNzZXRFcnJvci5jbGVhckFsbCgpO1xyXG4gICAgdGhpcy5wcm9maWxlID0gbnVsbDtcclxuICAgIHRoaXMuaGFuZGVkbmVzcyA9IG51bGw7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBSZXRyaWV2ZXMgdGhlIGZ1bGwgbGlzdCBvZiBhdmFpbGFibGUgcHJvZmlsZXMgYW5kIHBvcHVsYXRlcyB0aGUgZHJvcGRvd25cclxuICAgKi9cclxuICBhc3luYyBwb3B1bGF0ZVByb2ZpbGVTZWxlY3RvcigpIHtcclxuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcclxuICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgPSAnJztcclxuXHJcbiAgICAvLyBMb2FkIGFuZCBjbGVhciBsb2NhbCBzdG9yYWdlXHJcbiAgICBjb25zdCBzdG9yZWRQcm9maWxlSWQgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3Byb2ZpbGVJZCcpO1xyXG4gICAgd2luZG93LmxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKCdwcm9maWxlSWQnKTtcclxuXHJcbiAgICAvLyBMb2FkIHRoZSBsaXN0IG9mIHByb2ZpbGVzXHJcbiAgICBpZiAoIXRoaXMucHJvZmlsZXNMaXN0KSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MID0gJzxvcHRpb24gdmFsdWU9XCJsb2FkaW5nXCI+TG9hZGluZy4uLjwvb3B0aW9uPic7XHJcbiAgICAgICAgdGhpcy5wcm9maWxlc0xpc3QgPSBhd2FpdCBmZXRjaFByb2ZpbGVzTGlzdChwcm9maWxlc0Jhc2VQYXRoKTtcclxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgPSAnRmFpbGVkIHRvIGxvYWQgbGlzdCc7XHJcbiAgICAgICAgQXNzZXRFcnJvci5sb2coZXJyb3IubWVzc2FnZSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBBZGQgZWFjaCBwcm9maWxlIHRvIHRoZSBkcm9wZG93blxyXG4gICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XHJcbiAgICBPYmplY3Qua2V5cyh0aGlzLnByb2ZpbGVzTGlzdCkuZm9yRWFjaCgocHJvZmlsZUlkKSA9PiB7XHJcbiAgICAgIGNvbnN0IHByb2ZpbGUgPSB0aGlzLnByb2ZpbGVzTGlzdFtwcm9maWxlSWRdO1xyXG4gICAgICBpZiAoIXByb2ZpbGUuZGVwcmVjYXRlZCkge1xyXG4gICAgICAgIHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LmlubmVySFRNTCArPSBgXHJcbiAgICAgICAgPG9wdGlvbiB2YWx1ZT0nJHtwcm9maWxlSWR9Jz4ke3Byb2ZpbGVJZH08L29wdGlvbj5cclxuICAgICAgICBgO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBBZGQgdGhlIGxvY2FsIHByb2ZpbGUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBpbmNsdWRlZFxyXG4gICAgaWYgKHRoaXMubG9jYWxQcm9maWxlLnByb2ZpbGVJZFxyXG4gICAgICYmICFPYmplY3Qua2V5cyh0aGlzLnByb2ZpbGVzTGlzdCkuaW5jbHVkZXModGhpcy5sb2NhbFByb2ZpbGUucHJvZmlsZUlkKSkge1xyXG4gICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgKz0gYFxyXG4gICAgICA8b3B0aW9uIHZhbHVlPScke3RoaXMubG9jYWxQcm9maWxlLnByb2ZpbGVJZH0nPiR7dGhpcy5sb2NhbFByb2ZpbGUucHJvZmlsZUlkfTwvb3B0aW9uPlxyXG4gICAgICBgO1xyXG4gICAgICB0aGlzLnByb2ZpbGVzTGlzdFt0aGlzLmxvY2FsUHJvZmlsZS5wcm9maWxlSWRdID0gdGhpcy5sb2NhbFByb2ZpbGU7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gT3ZlcnJpZGUgdGhlIGRlZmF1bHQgc2VsZWN0aW9uIGlmIHZhbHVlcyB3ZXJlIHByZXNlbnQgaW4gbG9jYWwgc3RvcmFnZVxyXG4gICAgaWYgKHN0b3JlZFByb2ZpbGVJZCkge1xyXG4gICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC52YWx1ZSA9IHN0b3JlZFByb2ZpbGVJZDtcclxuICAgIH1cclxuXHJcbiAgICAvLyBNYW51YWxseSB0cmlnZ2VyIHNlbGVjdGVkIHByb2ZpbGUgdG8gbG9hZFxyXG4gICAgdGhpcy5vblByb2ZpbGVJZENoYW5nZSgpO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogSGFuZGxlciBmb3IgdGhlIHByb2ZpbGUgaWQgc2VsZWN0aW9uIGNoYW5nZVxyXG4gICAqL1xyXG4gIG9uUHJvZmlsZUlkQ2hhbmdlKCkge1xyXG4gICAgdGhpcy5jbGVhclNlbGVjdGVkUHJvZmlsZSgpO1xyXG4gICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3JFbGVtZW50LmlubmVySFRNTCA9ICcnO1xyXG5cclxuICAgIGNvbnN0IHByb2ZpbGVJZCA9IHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LnZhbHVlO1xyXG4gICAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKCdwcm9maWxlSWQnLCBwcm9maWxlSWQpO1xyXG5cclxuICAgIGlmIChwcm9maWxlSWQgPT09IHRoaXMubG9jYWxQcm9maWxlLnByb2ZpbGVJZCkge1xyXG4gICAgICB0aGlzLnByb2ZpbGUgPSB0aGlzLmxvY2FsUHJvZmlsZS5wcm9maWxlO1xyXG4gICAgICB0aGlzLnBvcHVsYXRlSGFuZGVkbmVzc1NlbGVjdG9yKCk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAvLyBBdHRlbXB0IHRvIGxvYWQgdGhlIHByb2ZpbGVcclxuICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgICBmZXRjaFByb2ZpbGUoeyBwcm9maWxlczogW3Byb2ZpbGVJZF0sIGhhbmRlZG5lc3M6ICdhbnknIH0sIHByb2ZpbGVzQmFzZVBhdGgsIG51bGwsIGZhbHNlKS50aGVuKCh7IHByb2ZpbGUgfSkgPT4ge1xyXG4gICAgICAgIHRoaXMucHJvZmlsZSA9IHByb2ZpbGU7XHJcbiAgICAgICAgdGhpcy5wb3B1bGF0ZUhhbmRlZG5lc3NTZWxlY3RvcigpO1xyXG4gICAgICB9KVxyXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICAgIEFzc2V0RXJyb3IubG9nKGVycm9yLm1lc3NhZ2UpO1xyXG4gICAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICAgICAgfSlcclxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XHJcbiAgICAgICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5kaXNhYmxlZCA9IGZhbHNlO1xyXG4gICAgICAgICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3JFbGVtZW50LmRpc2FibGVkID0gZmFsc2U7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBQb3B1bGF0ZXMgdGhlIGhhbmRlZG5lc3MgZHJvcGRvd24gd2l0aCB0aG9zZSBzdXBwb3J0ZWQgYnkgdGhlIHNlbGVjdGVkIHByb2ZpbGVcclxuICAgKi9cclxuICBwb3B1bGF0ZUhhbmRlZG5lc3NTZWxlY3RvcigpIHtcclxuICAgIC8vIExvYWQgYW5kIGNsZWFyIHRoZSBsYXN0IHNlbGVjdGlvbiBmb3IgdGhpcyBwcm9maWxlIGlkXHJcbiAgICBjb25zdCBzdG9yZWRIYW5kZWRuZXNzID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKCdoYW5kZWRuZXNzJyk7XHJcbiAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oJ2hhbmRlZG5lc3MnKTtcclxuXHJcbiAgICAvLyBQb3B1bGF0ZSBoYW5kZWRuZXNzIHNlbGVjdG9yXHJcbiAgICBPYmplY3Qua2V5cyh0aGlzLnByb2ZpbGUubGF5b3V0cykuZm9yRWFjaCgoaGFuZGVkbmVzcykgPT4ge1xyXG4gICAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MICs9IGBcclxuICAgICAgICA8b3B0aW9uIHZhbHVlPScke2hhbmRlZG5lc3N9Jz4ke2hhbmRlZG5lc3N9PC9vcHRpb24+XHJcbiAgICAgIGA7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBBcHBseSBzdG9yZWQgaGFuZGVkbmVzcyBpZiBmb3VuZFxyXG4gICAgaWYgKHN0b3JlZEhhbmRlZG5lc3MgJiYgdGhpcy5wcm9maWxlLmxheW91dHNbc3RvcmVkSGFuZGVkbmVzc10pIHtcclxuICAgICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3JFbGVtZW50LnZhbHVlID0gc3RvcmVkSGFuZGVkbmVzcztcclxuICAgIH1cclxuXHJcbiAgICAvLyBNYW51YWxseSB0cmlnZ2VyIHNlbGVjdGVkIGhhbmRlZG5lc3MgY2hhbmdlXHJcbiAgICB0aGlzLm9uSGFuZGVkbmVzc0NoYW5nZSgpO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogUmVzcG9uZHMgdG8gY2hhbmdlcyBpbiBzZWxlY3RlZCBoYW5kZWRuZXNzLlxyXG4gICAqIENyZWF0ZXMgYSBuZXcgbW90aW9uIGNvbnRyb2xsZXIgZm9yIHRoZSBjb21iaW5hdGlvbiBvZiBwcm9maWxlIGFuZCBoYW5kZWRuZXNzLCBhbmQgZmlyZXMgYW5cclxuICAgKiBldmVudCB0byBzaWduYWwgdGhlIGNoYW5nZVxyXG4gICAqL1xyXG4gIG9uSGFuZGVkbmVzc0NoYW5nZSgpIHtcclxuICAgIEFzc2V0RXJyb3IuY2xlYXJBbGwoKTtcclxuICAgIHRoaXMuaGFuZGVkbmVzcyA9IHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yRWxlbWVudC52YWx1ZTtcclxuICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnaGFuZGVkbmVzcycsIHRoaXMuaGFuZGVkbmVzcyk7XHJcbiAgICBpZiAodGhpcy5oYW5kZWRuZXNzKSB7XHJcbiAgICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ3NlbGVjdGlvbmNoYW5nZScpKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ3NlbGVjdGlvbmNsZWFyJykpO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogVXBkYXRlcyB0aGUgcHJvZmlsZXMgZHJvcGRvd24gdG8gZW5zdXJlIGxvY2FsIHByb2ZpbGUgaXMgaW4gdGhlIGxpc3RcclxuICAgKi9cclxuICBvbkxvY2FsUHJvZmlsZUNoYW5nZSgpIHtcclxuICAgIHRoaXMucG9wdWxhdGVQcm9maWxlU2VsZWN0b3IoKTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIEluZGljYXRlcyBpZiB0aGUgY3VycmVudGx5IHNlbGVjdGVkIHByb2ZpbGUgc2hvdWxkIGJlIHNob3duIGluIFZSIGluc3RlYWRcclxuICAgKiBvZiB0aGUgcHJvZmlsZXMgYWR2ZXJ0aXNlZCBieSB0aGUgcmVhbCBYUklucHV0U291cmNlLlxyXG4gICAqL1xyXG4gIGdldCBmb3JjZVZSUHJvZmlsZSgpIHtcclxuICAgIHJldHVybiB0aGlzLmZvcmNlVlJQcm9maWxlRWxlbWVudC5jaGVja2VkO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogSW5kaWNhdGVzIGlmIHRoZSB0YXJnZXRSYXlTcGFjZSBmb3IgYW4gaW5wdXQgc291cmNlIHNob3VsZCBiZSB2aXN1YWxpemVkIGluXHJcbiAgICogVlIuXHJcbiAgICovXHJcbiAgZ2V0IHNob3dUYXJnZXRSYXkoKSB7XHJcbiAgICByZXR1cm4gdGhpcy5zaG93VGFyZ2V0UmF5RWxlbWVudC5jaGVja2VkO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogQnVpbGRzIGEgTW90aW9uQ29udHJvbGxlciBlaXRoZXIgYmFzZWQgb24gdGhlIHN1cHBsaWVkIGlucHV0IHNvdXJjZSB1c2luZyB0aGUgbG9jYWwgcHJvZmlsZVxyXG4gICAqIGlmIGl0IGlzIHRoZSBiZXN0IG1hdGNoLCBvdGhlcndpc2UgdXNlcyB0aGUgcmVtb3RlIGFzc2V0c1xyXG4gICAqIEBwYXJhbSB7WFJJbnB1dFNvdXJjZX0geHJJbnB1dFNvdXJjZVxyXG4gICAqL1xyXG4gIGFzeW5jIGNyZWF0ZU1vdGlvbkNvbnRyb2xsZXIoeHJJbnB1dFNvdXJjZSkge1xyXG4gICAgbGV0IHByb2ZpbGU7XHJcbiAgICBsZXQgYXNzZXRQYXRoO1xyXG5cclxuICAgIC8vIENoZWNrIGlmIGxvY2FsIG92ZXJyaWRlIHNob3VsZCBiZSB1c2VkXHJcbiAgICBsZXQgdXNlTG9jYWxQcm9maWxlID0gZmFsc2U7XHJcbiAgICBpZiAodGhpcy5sb2NhbFByb2ZpbGUucHJvZmlsZUlkKSB7XHJcbiAgICAgIHhySW5wdXRTb3VyY2UucHJvZmlsZXMuc29tZSgocHJvZmlsZUlkKSA9PiB7XHJcbiAgICAgICAgY29uc3QgbWF0Y2hGb3VuZCA9IE9iamVjdC5rZXlzKHRoaXMucHJvZmlsZXNMaXN0KS5pbmNsdWRlcyhwcm9maWxlSWQpO1xyXG4gICAgICAgIHVzZUxvY2FsUHJvZmlsZSA9IG1hdGNoRm91bmQgJiYgKHByb2ZpbGVJZCA9PT0gdGhpcy5sb2NhbFByb2ZpbGUucHJvZmlsZUlkKTtcclxuICAgICAgICByZXR1cm4gbWF0Y2hGb3VuZDtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gR2V0IHByb2ZpbGUgYW5kIGFzc2V0IHBhdGhcclxuICAgIGlmICh1c2VMb2NhbFByb2ZpbGUpIHtcclxuICAgICAgKHsgcHJvZmlsZSB9ID0gdGhpcy5sb2NhbFByb2ZpbGUpO1xyXG4gICAgICBjb25zdCBhc3NldE5hbWUgPSB0aGlzLmxvY2FsUHJvZmlsZS5wcm9maWxlLmxheW91dHNbeHJJbnB1dFNvdXJjZS5oYW5kZWRuZXNzXS5hc3NldFBhdGg7XHJcbiAgICAgIGFzc2V0UGF0aCA9IHRoaXMubG9jYWxQcm9maWxlLmFzc2V0c1thc3NldE5hbWVdIHx8IGFzc2V0TmFtZTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICh7IHByb2ZpbGUsIGFzc2V0UGF0aCB9ID0gYXdhaXQgZmV0Y2hQcm9maWxlKHhySW5wdXRTb3VyY2UsIHByb2ZpbGVzQmFzZVBhdGgpKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBCdWlsZCBtb3Rpb24gY29udHJvbGxlclxyXG4gICAgY29uc3QgbW90aW9uQ29udHJvbGxlciA9IG5ldyBNb3Rpb25Db250cm9sbGVyKFxyXG4gICAgICB4cklucHV0U291cmNlLFxyXG4gICAgICBwcm9maWxlLFxyXG4gICAgICBhc3NldFBhdGhcclxuICAgICk7XHJcblxyXG4gICAgcmV0dXJuIG1vdGlvbkNvbnRyb2xsZXI7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBQcm9maWxlU2VsZWN0b3I7XHJcbiIsImNvbnN0IGRlZmF1bHRCYWNrZ3JvdW5kID0gJ2dlb3JnZW50b3InO1xyXG5cclxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgQmFja2dyb3VuZFNlbGVjdG9yIGV4dGVuZHMgRXZlbnRUYXJnZXQge1xyXG4gIGNvbnN0cnVjdG9yKCkge1xyXG4gICAgc3VwZXIoKTtcclxuXHJcbiAgICB0aGlzLmJhY2tncm91bmRTZWxlY3RvckVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYmFja2dyb3VuZFNlbGVjdG9yJyk7XHJcbiAgICB0aGlzLmJhY2tncm91bmRTZWxlY3RvckVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyB0aGlzLm9uQmFja2dyb3VuZENoYW5nZSgpOyB9KTtcclxuXHJcbiAgICB0aGlzLnNlbGVjdGVkQmFja2dyb3VuZCA9IHdpbmRvdy5sb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnYmFja2dyb3VuZCcpIHx8IGRlZmF1bHRCYWNrZ3JvdW5kO1xyXG4gICAgdGhpcy5iYWNrZ3JvdW5kTGlzdCA9IHt9O1xyXG4gICAgZmV0Y2goJ2JhY2tncm91bmRzL2JhY2tncm91bmRzLmpzb24nKVxyXG4gICAgICAudGhlbihyZXNwb25zZSA9PiByZXNwb25zZS5qc29uKCkpXHJcbiAgICAgIC50aGVuKChiYWNrZ3JvdW5kcykgPT4ge1xyXG4gICAgICAgIHRoaXMuYmFja2dyb3VuZExpc3QgPSBiYWNrZ3JvdW5kcztcclxuICAgICAgICBPYmplY3Qua2V5cyhiYWNrZ3JvdW5kcykuZm9yRWFjaCgoYmFja2dyb3VuZCkgPT4ge1xyXG4gICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XHJcbiAgICAgICAgICBvcHRpb24udmFsdWUgPSBiYWNrZ3JvdW5kO1xyXG4gICAgICAgICAgb3B0aW9uLmlubmVyVGV4dCA9IGJhY2tncm91bmQ7XHJcbiAgICAgICAgICBpZiAodGhpcy5zZWxlY3RlZEJhY2tncm91bmQgPT09IGJhY2tncm91bmQpIHtcclxuICAgICAgICAgICAgb3B0aW9uLnNlbGVjdGVkID0gdHJ1ZTtcclxuICAgICAgICAgIH1cclxuICAgICAgICAgIHRoaXMuYmFja2dyb3VuZFNlbGVjdG9yRWxlbWVudC5hcHBlbmRDaGlsZChvcHRpb24pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ3NlbGVjdGlvbmNoYW5nZScpKTtcclxuICAgICAgfSk7XHJcbiAgfVxyXG5cclxuICBvbkJhY2tncm91bmRDaGFuZ2UoKSB7XHJcbiAgICB0aGlzLnNlbGVjdGVkQmFja2dyb3VuZCA9IHRoaXMuYmFja2dyb3VuZFNlbGVjdG9yRWxlbWVudC52YWx1ZTtcclxuICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnYmFja2dyb3VuZCcsIHRoaXMuc2VsZWN0ZWRCYWNrZ3JvdW5kKTtcclxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ3NlbGVjdGlvbmNoYW5nZScpKTtcclxuICB9XHJcblxyXG4gIGdldCBiYWNrZ3JvdW5kUGF0aCgpIHtcclxuICAgIHJldHVybiB0aGlzLmJhY2tncm91bmRMaXN0W3RoaXMuc2VsZWN0ZWRCYWNrZ3JvdW5kXTtcclxuICB9XHJcbn1cclxuIiwiLyogZXNsaW50LWRpc2FibGUgaW1wb3J0L25vLXVucmVzb2x2ZWQgKi9cclxuaW1wb3J0IHsgQ29uc3RhbnRzIH0gZnJvbSAnLi4vbW90aW9uLWNvbnRyb2xsZXJzLm1vZHVsZS5qcyc7XHJcbi8qIGVzbGludC1lbmFibGUgKi9cclxuXHJcbi8qKlxyXG4gKiBBIGZhbHNlIGdhbWVwYWQgdG8gYmUgdXNlZCBpbiB0ZXN0c1xyXG4gKi9cclxuY2xhc3MgTW9ja0dhbWVwYWQge1xyXG4gIC8qKlxyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBwcm9maWxlRGVzY3JpcHRpb24gLSBUaGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBwYXJzZSB0byBkZXRlcm1pbmUgdGhlIGxlbmd0aFxyXG4gICAqIG9mIHRoZSBidXR0b24gYW5kIGF4ZXMgYXJyYXlzXHJcbiAgICogQHBhcmFtIHtzdHJpbmd9IGhhbmRlZG5lc3MgLSBUaGUgZ2FtZXBhZCdzIGhhbmRlZG5lc3NcclxuICAgKi9cclxuICBjb25zdHJ1Y3Rvcihwcm9maWxlRGVzY3JpcHRpb24sIGhhbmRlZG5lc3MpIHtcclxuICAgIGlmICghcHJvZmlsZURlc2NyaXB0aW9uKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gcHJvZmlsZURlc2NyaXB0aW9uIHN1cHBsaWVkJyk7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFoYW5kZWRuZXNzKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gaGFuZGVkbmVzcyBzdXBwbGllZCcpO1xyXG4gICAgfVxyXG5cclxuICAgIHRoaXMuaWQgPSBwcm9maWxlRGVzY3JpcHRpb24ucHJvZmlsZUlkO1xyXG5cclxuICAgIC8vIExvb3AgdGhyb3VnaCB0aGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBkZXRlcm1pbmUgaG93IG1hbnkgZWxlbWVudHMgdG8gcHV0IGluIHRoZSBidXR0b25zXHJcbiAgICAvLyBhbmQgYXhlcyBhcnJheXNcclxuICAgIGxldCBtYXhCdXR0b25JbmRleCA9IDA7XHJcbiAgICBsZXQgbWF4QXhpc0luZGV4ID0gMDtcclxuICAgIGNvbnN0IGxheW91dCA9IHByb2ZpbGVEZXNjcmlwdGlvbi5sYXlvdXRzW2hhbmRlZG5lc3NdO1xyXG4gICAgdGhpcy5tYXBwaW5nID0gbGF5b3V0Lm1hcHBpbmc7XHJcbiAgICBPYmplY3QudmFsdWVzKGxheW91dC5jb21wb25lbnRzKS5mb3JFYWNoKCh7IGdhbWVwYWRJbmRpY2VzIH0pID0+IHtcclxuICAgICAgY29uc3Qge1xyXG4gICAgICAgIFtDb25zdGFudHMuQ29tcG9uZW50UHJvcGVydHkuQlVUVE9OXTogYnV0dG9uSW5kZXgsXHJcbiAgICAgICAgW0NvbnN0YW50cy5Db21wb25lbnRQcm9wZXJ0eS5YX0FYSVNdOiB4QXhpc0luZGV4LFxyXG4gICAgICAgIFtDb25zdGFudHMuQ29tcG9uZW50UHJvcGVydHkuWV9BWElTXTogeUF4aXNJbmRleFxyXG4gICAgICB9ID0gZ2FtZXBhZEluZGljZXM7XHJcblxyXG4gICAgICBpZiAoYnV0dG9uSW5kZXggIT09IHVuZGVmaW5lZCAmJiBidXR0b25JbmRleCA+IG1heEJ1dHRvbkluZGV4KSB7XHJcbiAgICAgICAgbWF4QnV0dG9uSW5kZXggPSBidXR0b25JbmRleDtcclxuICAgICAgfVxyXG5cclxuICAgICAgaWYgKHhBeGlzSW5kZXggIT09IHVuZGVmaW5lZCAmJiAoeEF4aXNJbmRleCA+IG1heEF4aXNJbmRleCkpIHtcclxuICAgICAgICBtYXhBeGlzSW5kZXggPSB4QXhpc0luZGV4O1xyXG4gICAgICB9XHJcblxyXG4gICAgICBpZiAoeUF4aXNJbmRleCAhPT0gdW5kZWZpbmVkICYmICh5QXhpc0luZGV4ID4gbWF4QXhpc0luZGV4KSkge1xyXG4gICAgICAgIG1heEF4aXNJbmRleCA9IHlBeGlzSW5kZXg7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEZpbGwgdGhlIGF4ZXMgYXJyYXlcclxuICAgIHRoaXMuYXhlcyA9IFtdO1xyXG4gICAgd2hpbGUgKHRoaXMuYXhlcy5sZW5ndGggPD0gbWF4QXhpc0luZGV4KSB7XHJcbiAgICAgIHRoaXMuYXhlcy5wdXNoKDApO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEZpbGwgdGhlIGJ1dHRvbnMgYXJyYXlcclxuICAgIHRoaXMuYnV0dG9ucyA9IFtdO1xyXG4gICAgd2hpbGUgKHRoaXMuYnV0dG9ucy5sZW5ndGggPD0gbWF4QnV0dG9uSW5kZXgpIHtcclxuICAgICAgdGhpcy5idXR0b25zLnB1c2goe1xyXG4gICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgIHRvdWNoZWQ6IGZhbHNlLFxyXG4gICAgICAgIHByZXNzZWQ6IGZhbHNlXHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGRlZmF1bHQgTW9ja0dhbWVwYWQ7XHJcbiIsIi8qKlxyXG4gKiBBIGZha2UgWFJJbnB1dFNvdXJjZSB0aGF0IGNhbiBiZSB1c2VkIHRvIGluaXRpYWxpemUgYSBNb3Rpb25Db250cm9sbGVyXHJcbiAqL1xyXG5jbGFzcyBNb2NrWFJJbnB1dFNvdXJjZSB7XHJcbiAgLyoqXHJcbiAgICogQHBhcmFtIHtPYmplY3R9IGdhbWVwYWQgLSBUaGUgR2FtZXBhZCBvYmplY3QgdGhhdCBwcm92aWRlcyB0aGUgYnV0dG9uIGFuZCBheGlzIGRhdGFcclxuICAgKiBAcGFyYW0ge3N0cmluZ30gaGFuZGVkbmVzcyAtIFRoZSBoYW5kZWRuZXNzIHRvIHJlcG9ydFxyXG4gICAqL1xyXG4gIGNvbnN0cnVjdG9yKHByb2ZpbGVzLCBnYW1lcGFkLCBoYW5kZWRuZXNzKSB7XHJcbiAgICB0aGlzLmdhbWVwYWQgPSBnYW1lcGFkO1xyXG5cclxuICAgIGlmICghaGFuZGVkbmVzcykge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIGhhbmRlZG5lc3Mgc3VwcGxpZWQnKTtcclxuICAgIH1cclxuXHJcbiAgICB0aGlzLmhhbmRlZG5lc3MgPSBoYW5kZWRuZXNzO1xyXG4gICAgdGhpcy5wcm9maWxlcyA9IE9iamVjdC5mcmVlemUocHJvZmlsZXMpO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGRlZmF1bHQgTW9ja1hSSW5wdXRTb3VyY2U7XHJcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXHJcbmltcG9ydCAqIGFzIFRIUkVFIGZyb20gJy4vdGhyZWUvYnVpbGQvdGhyZWUubW9kdWxlLmpzJztcclxuaW1wb3J0IHsgT3JiaXRDb250cm9scyB9IGZyb20gJy4vdGhyZWUvZXhhbXBsZXMvanNtL2NvbnRyb2xzL09yYml0Q29udHJvbHMuanMnO1xyXG5pbXBvcnQgeyBSR0JFTG9hZGVyIH0gZnJvbSAnLi90aHJlZS9leGFtcGxlcy9qc20vbG9hZGVycy9SR0JFTG9hZGVyLmpzJztcclxuaW1wb3J0IHsgVlJCdXR0b24gfSBmcm9tICcuL3RocmVlL2V4YW1wbGVzL2pzbS93ZWJ4ci9WUkJ1dHRvbi5qcyc7XHJcbi8qIGVzbGludC1lbmFibGUgKi9cclxuXHJcbmltcG9ydCBNYW51YWxDb250cm9scyBmcm9tICcuL21hbnVhbENvbnRyb2xzLmpzJztcclxuaW1wb3J0IENvbnRyb2xsZXJNb2RlbCBmcm9tICcuL2NvbnRyb2xsZXJNb2RlbC5qcyc7XHJcbmltcG9ydCBQcm9maWxlU2VsZWN0b3IgZnJvbSAnLi9wcm9maWxlU2VsZWN0b3IuanMnO1xyXG5pbXBvcnQgQmFja2dyb3VuZFNlbGVjdG9yIGZyb20gJy4vYmFja2dyb3VuZFNlbGVjdG9yLmpzJztcclxuaW1wb3J0IEFzc2V0RXJyb3IgZnJvbSAnLi9hc3NldEVycm9yLmpzJztcclxuaW1wb3J0IE1vY2tHYW1lcGFkIGZyb20gJy4vbW9ja3MvbW9ja0dhbWVwYWQuanMnO1xyXG5pbXBvcnQgTW9ja1hSSW5wdXRTb3VyY2UgZnJvbSAnLi9tb2Nrcy9tb2NrWFJJbnB1dFNvdXJjZS5qcyc7XHJcblxyXG5jb25zdCB0aHJlZSA9IHt9O1xyXG5sZXQgY2FudmFzUGFyZW50RWxlbWVudDtcclxubGV0IHZyUHJvZmlsZXNFbGVtZW50O1xyXG5sZXQgdnJQcm9maWxlc0xpc3RFbGVtZW50O1xyXG5cclxubGV0IHByb2ZpbGVTZWxlY3RvcjtcclxubGV0IGJhY2tncm91bmRTZWxlY3RvcjtcclxubGV0IG1vY2tDb250cm9sbGVyTW9kZWw7XHJcbmxldCBpc0ltbWVyc2l2ZSA9IGZhbHNlO1xyXG5cclxuLyoqXHJcbiAqIEFkZHMgdGhlIGV2ZW50IGhhbmRsZXJzIGZvciBWUiBtb3Rpb24gY29udHJvbGxlcnMgdG8gbG9hZCB0aGUgYXNzZXRzIG9uIGNvbm5lY3Rpb25cclxuICogYW5kIHJlbW92ZSB0aGVtIG9uIGRpc2Nvbm5lY3Rpb25cclxuICogQHBhcmFtIHtudW1iZXJ9IGluZGV4XHJcbiAqL1xyXG5mdW5jdGlvbiBpbml0aWFsaXplVlJDb250cm9sbGVyKGluZGV4KSB7XHJcbiAgY29uc3QgdnJDb250cm9sbGVyR3JpcCA9IHRocmVlLnJlbmRlcmVyLnhyLmdldENvbnRyb2xsZXJHcmlwKGluZGV4KTtcclxuXHJcbiAgdnJDb250cm9sbGVyR3JpcC5hZGRFdmVudExpc3RlbmVyKCdjb25uZWN0ZWQnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXJNb2RlbCA9IG5ldyBDb250cm9sbGVyTW9kZWwoKTtcclxuICAgIHZyQ29udHJvbGxlckdyaXAuYWRkKGNvbnRyb2xsZXJNb2RlbCk7XHJcblxyXG4gICAgbGV0IHhySW5wdXRTb3VyY2UgPSBldmVudC5kYXRhO1xyXG5cclxuICAgIHZyUHJvZmlsZXNMaXN0RWxlbWVudC5pbm5lckhUTUwgKz0gYDxsaT48Yj4ke3hySW5wdXRTb3VyY2UuaGFuZGVkbmVzc306PC9iPiBbJHt4cklucHV0U291cmNlLnByb2ZpbGVzfV08L2xpPmA7XHJcblxyXG4gICAgaWYgKHByb2ZpbGVTZWxlY3Rvci5mb3JjZVZSUHJvZmlsZSkge1xyXG4gICAgICB4cklucHV0U291cmNlID0gbmV3IE1vY2tYUklucHV0U291cmNlKFxyXG4gICAgICAgIFtwcm9maWxlU2VsZWN0b3IucHJvZmlsZS5wcm9maWxlSWRdLCBldmVudC5kYXRhLmdhbWVwYWQsIGV2ZW50LmRhdGEuaGFuZGVkbmVzc1xyXG4gICAgICApO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1vdGlvbkNvbnRyb2xsZXIgPSBhd2FpdCBwcm9maWxlU2VsZWN0b3IuY3JlYXRlTW90aW9uQ29udHJvbGxlcih4cklucHV0U291cmNlKTtcclxuICAgIGF3YWl0IGNvbnRyb2xsZXJNb2RlbC5pbml0aWFsaXplKG1vdGlvbkNvbnRyb2xsZXIpO1xyXG5cclxuICAgIGlmICh0aHJlZS5lbnZpcm9ubWVudE1hcCkge1xyXG4gICAgICBjb250cm9sbGVyTW9kZWwuZW52aXJvbm1lbnRNYXAgPSB0aHJlZS5lbnZpcm9ubWVudE1hcDtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgdnJDb250cm9sbGVyR3JpcC5hZGRFdmVudExpc3RlbmVyKCdkaXNjb25uZWN0ZWQnLCAoKSA9PiB7XHJcbiAgICB2ckNvbnRyb2xsZXJHcmlwLnJlbW92ZSh2ckNvbnRyb2xsZXJHcmlwLmNoaWxkcmVuWzBdKTtcclxuICB9KTtcclxuXHJcbiAgdGhyZWUuc2NlbmUuYWRkKHZyQ29udHJvbGxlckdyaXApO1xyXG5cclxuICBjb25zdCB2ckNvbnRyb2xsZXJUYXJnZXQgPSB0aHJlZS5yZW5kZXJlci54ci5nZXRDb250cm9sbGVyKGluZGV4KTtcclxuXHJcbiAgdnJDb250cm9sbGVyVGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Nvbm5lY3RlZCcsICgpID0+IHtcclxuICAgIGlmIChwcm9maWxlU2VsZWN0b3Iuc2hvd1RhcmdldFJheSkge1xyXG4gICAgICBjb25zdCBnZW9tZXRyeSA9IG5ldyBUSFJFRS5CdWZmZXJHZW9tZXRyeSgpO1xyXG4gICAgICBnZW9tZXRyeS5zZXRBdHRyaWJ1dGUoJ3Bvc2l0aW9uJywgbmV3IFRIUkVFLkZsb2F0MzJCdWZmZXJBdHRyaWJ1dGUoWzAsIDAsIDAsIDAsIDAsIC0xXSwgMykpO1xyXG4gICAgICBnZW9tZXRyeS5zZXRBdHRyaWJ1dGUoJ2NvbG9yJywgbmV3IFRIUkVFLkZsb2F0MzJCdWZmZXJBdHRyaWJ1dGUoWzAuNSwgMC41LCAwLjUsIDAsIDAsIDBdLCAzKSk7XHJcblxyXG4gICAgICBjb25zdCBtYXRlcmlhbCA9IG5ldyBUSFJFRS5MaW5lQmFzaWNNYXRlcmlhbCh7XHJcbiAgICAgICAgdmVydGV4Q29sb3JzOiBUSFJFRS5WZXJ0ZXhDb2xvcnMsXHJcbiAgICAgICAgYmxlbmRpbmc6IFRIUkVFLkFkZGl0aXZlQmxlbmRpbmdcclxuICAgICAgfSk7XHJcblxyXG4gICAgICB2ckNvbnRyb2xsZXJUYXJnZXQuYWRkKG5ldyBUSFJFRS5MaW5lKGdlb21ldHJ5LCBtYXRlcmlhbCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICB2ckNvbnRyb2xsZXJUYXJnZXQuYWRkRXZlbnRMaXN0ZW5lcignZGlzY29ubmVjdGVkJywgKCkgPT4ge1xyXG4gICAgaWYgKHZyQ29udHJvbGxlclRhcmdldC5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgdnJDb250cm9sbGVyVGFyZ2V0LnJlbW92ZSh2ckNvbnRyb2xsZXJUYXJnZXQuY2hpbGRyZW5bMF0pO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICB0aHJlZS5zY2VuZS5hZGQodnJDb250cm9sbGVyVGFyZ2V0KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRoZSB0aHJlZS5qcyByZW5kZXIgbG9vcCAodXNlZCBpbnN0ZWFkIG9mIHJlcXVlc3RBbmltYXRpb25GcmFtZSB0byBzdXBwb3J0IFhSKVxyXG4gKi9cclxuZnVuY3Rpb24gcmVuZGVyKCkge1xyXG4gIGlmIChtb2NrQ29udHJvbGxlck1vZGVsKSB7XHJcbiAgICBpZiAoaXNJbW1lcnNpdmUpIHtcclxuICAgICAgdGhyZWUuc2NlbmUucmVtb3ZlKG1vY2tDb250cm9sbGVyTW9kZWwpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhyZWUuc2NlbmUuYWRkKG1vY2tDb250cm9sbGVyTW9kZWwpO1xyXG4gICAgICBNYW51YWxDb250cm9scy51cGRhdGVUZXh0KCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICB0aHJlZS5jYW1lcmFDb250cm9scy51cGRhdGUoKTtcclxuXHJcbiAgdGhyZWUucmVuZGVyZXIucmVuZGVyKHRocmVlLnNjZW5lLCB0aHJlZS5jYW1lcmEpO1xyXG59XHJcblxyXG4vKipcclxuICogQGRlc2NyaXB0aW9uIEV2ZW50IGhhbmRsZXIgZm9yIHdpbmRvdyByZXNpemluZy5cclxuICovXHJcbmZ1bmN0aW9uIG9uUmVzaXplKCkge1xyXG4gIGNvbnN0IHdpZHRoID0gY2FudmFzUGFyZW50RWxlbWVudC5jbGllbnRXaWR0aDtcclxuICBjb25zdCBoZWlnaHQgPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudEhlaWdodDtcclxuICB0aHJlZS5jYW1lcmEuYXNwZWN0ID0gd2lkdGggLyBoZWlnaHQ7XHJcbiAgdGhyZWUuY2FtZXJhLnVwZGF0ZVByb2plY3Rpb25NYXRyaXgoKTtcclxuICB0aHJlZS5yZW5kZXJlci5zZXRTaXplKHdpZHRoLCBoZWlnaHQpO1xyXG4gIHRocmVlLmNhbWVyYUNvbnRyb2xzLnVwZGF0ZSgpO1xyXG59XHJcblxyXG4vKipcclxuICogSW5pdGlhbGl6ZXMgdGhlIHRocmVlLmpzIHJlc291cmNlcyBuZWVkZWQgZm9yIHRoaXMgcGFnZVxyXG4gKi9cclxuZnVuY3Rpb24gaW5pdGlhbGl6ZVRocmVlKCkge1xyXG4gIGNhbnZhc1BhcmVudEVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbW9kZWxWaWV3ZXInKTtcclxuICBjb25zdCB3aWR0aCA9IGNhbnZhc1BhcmVudEVsZW1lbnQuY2xpZW50V2lkdGg7XHJcbiAgY29uc3QgaGVpZ2h0ID0gY2FudmFzUGFyZW50RWxlbWVudC5jbGllbnRIZWlnaHQ7XHJcblxyXG4gIHZyUHJvZmlsZXNFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZyUHJvZmlsZXMnKTtcclxuICB2clByb2ZpbGVzTGlzdEVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndnJQcm9maWxlc0xpc3QnKTtcclxuXHJcbiAgLy8gU2V0IHVwIHRoZSBUSFJFRS5qcyBpbmZyYXN0cnVjdHVyZVxyXG4gIHRocmVlLmNhbWVyYSA9IG5ldyBUSFJFRS5QZXJzcGVjdGl2ZUNhbWVyYSg3NSwgd2lkdGggLyBoZWlnaHQsIDAuMDEsIDEwMDApO1xyXG4gIHRocmVlLmNhbWVyYS5wb3NpdGlvbi55ID0gMC41O1xyXG4gIHRocmVlLnNjZW5lID0gbmV3IFRIUkVFLlNjZW5lKCk7XHJcbiAgdGhyZWUuc2NlbmUuYmFja2dyb3VuZCA9IG5ldyBUSFJFRS5Db2xvcigweDAwYWE0NCk7XHJcbiAgdGhyZWUucmVuZGVyZXIgPSBuZXcgVEhSRUUuV2ViR0xSZW5kZXJlcih7IGFudGlhbGlhczogdHJ1ZSB9KTtcclxuICB0aHJlZS5yZW5kZXJlci5zZXRTaXplKHdpZHRoLCBoZWlnaHQpO1xyXG4gIHRocmVlLnJlbmRlcmVyLm91dHB1dEVuY29kaW5nID0gVEhSRUUuc1JHQkVuY29kaW5nO1xyXG5cclxuICAvLyBTZXQgdXAgdGhlIGNvbnRyb2xzIGZvciBtb3ZpbmcgdGhlIHNjZW5lIGFyb3VuZFxyXG4gIHRocmVlLmNhbWVyYUNvbnRyb2xzID0gbmV3IE9yYml0Q29udHJvbHModGhyZWUuY2FtZXJhLCB0aHJlZS5yZW5kZXJlci5kb21FbGVtZW50KTtcclxuICB0aHJlZS5jYW1lcmFDb250cm9scy5lbmFibGVEYW1waW5nID0gdHJ1ZTtcclxuICB0aHJlZS5jYW1lcmFDb250cm9scy5taW5EaXN0YW5jZSA9IDAuMDU7XHJcbiAgdGhyZWUuY2FtZXJhQ29udHJvbHMubWF4RGlzdGFuY2UgPSAwLjM7XHJcbiAgdGhyZWUuY2FtZXJhQ29udHJvbHMuZW5hYmxlUGFuID0gZmFsc2U7XHJcbiAgdGhyZWUuY2FtZXJhQ29udHJvbHMudXBkYXRlKCk7XHJcblxyXG4gIC8vIEFkZCBWUlxyXG4gIGNhbnZhc1BhcmVudEVsZW1lbnQuYXBwZW5kQ2hpbGQoVlJCdXR0b24uY3JlYXRlQnV0dG9uKHRocmVlLnJlbmRlcmVyKSk7XHJcbiAgdGhyZWUucmVuZGVyZXIueHIuZW5hYmxlZCA9IHRydWU7XHJcbiAgdGhyZWUucmVuZGVyZXIueHIuYWRkRXZlbnRMaXN0ZW5lcignc2Vzc2lvbnN0YXJ0JywgKCkgPT4ge1xyXG4gICAgdnJQcm9maWxlc0VsZW1lbnQuaGlkZGVuID0gZmFsc2U7XHJcbiAgICB2clByb2ZpbGVzTGlzdEVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XHJcbiAgICBpc0ltbWVyc2l2ZSA9IHRydWU7XHJcbiAgfSk7XHJcbiAgdGhyZWUucmVuZGVyZXIueHIuYWRkRXZlbnRMaXN0ZW5lcignc2Vzc2lvbmVuZCcsICgpID0+IHsgaXNJbW1lcnNpdmUgPSBmYWxzZTsgfSk7XHJcbiAgaW5pdGlhbGl6ZVZSQ29udHJvbGxlcigwKTtcclxuICBpbml0aWFsaXplVlJDb250cm9sbGVyKDEpO1xyXG5cclxuICAvLyBBZGQgdGhlIFRIUkVFLmpzIGNhbnZhcyB0byB0aGUgcGFnZVxyXG4gIGNhbnZhc1BhcmVudEVsZW1lbnQuYXBwZW5kQ2hpbGQodGhyZWUucmVuZGVyZXIuZG9tRWxlbWVudCk7XHJcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsIG9uUmVzaXplLCBmYWxzZSk7XHJcblxyXG4gIC8vIFN0YXJ0IHB1bXBpbmcgZnJhbWVzXHJcbiAgdGhyZWUucmVuZGVyZXIuc2V0QW5pbWF0aW9uTG9vcChyZW5kZXIpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBvblNlbGVjdGlvbkNsZWFyKCkge1xyXG4gIE1hbnVhbENvbnRyb2xzLmNsZWFyKCk7XHJcbiAgaWYgKG1vY2tDb250cm9sbGVyTW9kZWwpIHtcclxuICAgIHRocmVlLnNjZW5lLnJlbW92ZShtb2NrQ29udHJvbGxlck1vZGVsKTtcclxuICAgIG1vY2tDb250cm9sbGVyTW9kZWwgPSBudWxsO1xyXG4gIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gb25TZWxlY3Rpb25DaGFuZ2UoKSB7XHJcbiAgb25TZWxlY3Rpb25DbGVhcigpO1xyXG4gIGNvbnN0IG1vY2tHYW1lcGFkID0gbmV3IE1vY2tHYW1lcGFkKHByb2ZpbGVTZWxlY3Rvci5wcm9maWxlLCBwcm9maWxlU2VsZWN0b3IuaGFuZGVkbmVzcyk7XHJcbiAgY29uc3QgbW9ja1hSSW5wdXRTb3VyY2UgPSBuZXcgTW9ja1hSSW5wdXRTb3VyY2UoXHJcbiAgICBbcHJvZmlsZVNlbGVjdG9yLnByb2ZpbGUucHJvZmlsZUlkXSwgbW9ja0dhbWVwYWQsIHByb2ZpbGVTZWxlY3Rvci5oYW5kZWRuZXNzXHJcbiAgKTtcclxuICBtb2NrQ29udHJvbGxlck1vZGVsID0gbmV3IENvbnRyb2xsZXJNb2RlbChtb2NrWFJJbnB1dFNvdXJjZSk7XHJcbiAgdGhyZWUuc2NlbmUuYWRkKG1vY2tDb250cm9sbGVyTW9kZWwpO1xyXG5cclxuICBjb25zdCBtb3Rpb25Db250cm9sbGVyID0gYXdhaXQgcHJvZmlsZVNlbGVjdG9yLmNyZWF0ZU1vdGlvbkNvbnRyb2xsZXIobW9ja1hSSW5wdXRTb3VyY2UpO1xyXG4gIE1hbnVhbENvbnRyb2xzLmJ1aWxkKG1vdGlvbkNvbnRyb2xsZXIpO1xyXG4gIGF3YWl0IG1vY2tDb250cm9sbGVyTW9kZWwuaW5pdGlhbGl6ZShtb3Rpb25Db250cm9sbGVyKTtcclxuXHJcbiAgaWYgKHRocmVlLmVudmlyb25tZW50TWFwKSB7XHJcbiAgICBtb2NrQ29udHJvbGxlck1vZGVsLmVudmlyb25tZW50TWFwID0gdGhyZWUuZW52aXJvbm1lbnRNYXA7XHJcbiAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBvbkJhY2tncm91bmRDaGFuZ2UoKSB7XHJcbiAgY29uc3QgcG1yZW1HZW5lcmF0b3IgPSBuZXcgVEhSRUUuUE1SRU1HZW5lcmF0b3IodGhyZWUucmVuZGVyZXIpO1xyXG4gIHBtcmVtR2VuZXJhdG9yLmNvbXBpbGVFcXVpcmVjdGFuZ3VsYXJTaGFkZXIoKTtcclxuXHJcbiAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcclxuICAgIGNvbnN0IHJnYmVMb2FkZXIgPSBuZXcgUkdCRUxvYWRlcigpO1xyXG4gICAgcmdiZUxvYWRlci5zZXREYXRhVHlwZShUSFJFRS5VbnNpZ25lZEJ5dGVUeXBlKTtcclxuICAgIHJnYmVMb2FkZXIuc2V0UGF0aCgnYmFja2dyb3VuZHMvJyk7XHJcbiAgICByZ2JlTG9hZGVyLmxvYWQoYmFja2dyb3VuZFNlbGVjdG9yLmJhY2tncm91bmRQYXRoLCAodGV4dHVyZSkgPT4ge1xyXG4gICAgICB0aHJlZS5lbnZpcm9ubWVudE1hcCA9IHBtcmVtR2VuZXJhdG9yLmZyb21FcXVpcmVjdGFuZ3VsYXIodGV4dHVyZSkudGV4dHVyZTtcclxuICAgICAgdGhyZWUuc2NlbmUuYmFja2dyb3VuZCA9IHRocmVlLmVudmlyb25tZW50TWFwO1xyXG5cclxuICAgICAgaWYgKG1vY2tDb250cm9sbGVyTW9kZWwpIHtcclxuICAgICAgICBtb2NrQ29udHJvbGxlck1vZGVsLmVudmlyb25tZW50TWFwID0gdGhyZWUuZW52aXJvbm1lbnRNYXA7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIHBtcmVtR2VuZXJhdG9yLmRpc3Bvc2UoKTtcclxuICAgICAgcmVzb2x2ZSh0aHJlZS5lbnZpcm9ubWVudE1hcCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhZ2UgbG9hZCBoYW5kbGVyIGZvciBpbml0aWFsemluZyB0aGluZ3MgdGhhdCBkZXBlbmQgb24gdGhlIERPTSB0byBiZSByZWFkeVxyXG4gKi9cclxuZnVuY3Rpb24gb25Mb2FkKCkge1xyXG4gIEFzc2V0RXJyb3IuaW5pdGlhbGl6ZSgpO1xyXG4gIHByb2ZpbGVTZWxlY3RvciA9IG5ldyBQcm9maWxlU2VsZWN0b3IoKTtcclxuICBpbml0aWFsaXplVGhyZWUoKTtcclxuXHJcbiAgcHJvZmlsZVNlbGVjdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ3NlbGVjdGlvbmNsZWFyJywgb25TZWxlY3Rpb25DbGVhcik7XHJcbiAgcHJvZmlsZVNlbGVjdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ3NlbGVjdGlvbmNoYW5nZScsIG9uU2VsZWN0aW9uQ2hhbmdlKTtcclxuXHJcbiAgYmFja2dyb3VuZFNlbGVjdG9yID0gbmV3IEJhY2tncm91bmRTZWxlY3RvcigpO1xyXG4gIGJhY2tncm91bmRTZWxlY3Rvci5hZGRFdmVudExpc3RlbmVyKCdzZWxlY3Rpb25jaGFuZ2UnLCBvbkJhY2tncm91bmRDaGFuZ2UpO1xyXG59XHJcbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdsb2FkJywgb25Mb2FkKTtcclxuIl0sIm5hbWVzIjpbIlRIUkVFLk9iamVjdDNEIiwiVEhSRUUuU3BoZXJlR2VvbWV0cnkiLCJUSFJFRS5NZXNoQmFzaWNNYXRlcmlhbCIsIlRIUkVFLk1lc2giLCJUSFJFRS5CdWZmZXJHZW9tZXRyeSIsIlRIUkVFLkZsb2F0MzJCdWZmZXJBdHRyaWJ1dGUiLCJUSFJFRS5MaW5lQmFzaWNNYXRlcmlhbCIsIlRIUkVFLlZlcnRleENvbG9ycyIsIlRIUkVFLkFkZGl0aXZlQmxlbmRpbmciLCJUSFJFRS5MaW5lIiwiVEhSRUUuUGVyc3BlY3RpdmVDYW1lcmEiLCJUSFJFRS5TY2VuZSIsIlRIUkVFLkNvbG9yIiwiVEhSRUUuV2ViR0xSZW5kZXJlciIsIlRIUkVFLnNSR0JFbmNvZGluZyIsIlRIUkVFLlBNUkVNR2VuZXJhdG9yIiwiVEhSRUUuVW5zaWduZWRCeXRlVHlwZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7QUFBQSxJQUFJLGdCQUFnQixDQUFDO0FBQ3JCLElBQUksV0FBVyxDQUFDO0FBQ2hCLElBQUksbUJBQW1CLENBQUM7O0FBRXhCLFNBQVMsVUFBVSxHQUFHO0VBQ3BCLElBQUksZ0JBQWdCLEVBQUU7SUFDcEIsTUFBTSxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxVQUFVLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxTQUFTLEtBQUs7TUFDaEUsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLGNBQWMsQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO01BQ3BFLFdBQVcsQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztLQUNqRSxDQUFDLENBQUM7R0FDSjtDQUNGOztBQUVELFNBQVMsbUJBQW1CLENBQUMsS0FBSyxFQUFFO0VBQ2xDLE1BQU0sRUFBRSxLQUFLLEVBQUUsR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQztFQUN2QyxXQUFXLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztDQUMvRDs7QUFFRCxTQUFTLGlCQUFpQixDQUFDLEtBQUssRUFBRTtFQUNoQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUM7RUFDdkMsV0FBVyxDQUFDLElBQUksQ0FBQyxLQUFL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
