import './style.css'
import mapboxgl from 'mapbox-gl'
import * as threebox from 'threebox-plugin'
import { MAPBOX_ACCESS_TOKEN, DEFAULT_COORDINATES, MAPBOX_STYLE_STANDARD, MAPBOX_STYLE_SATELLITE } from './config'
import { CameraController } from './game/CameraController'
import { InfoPanel } from './game/InfoPanel'
import { RealtimeController } from './game/realtime/RealtimeController'
import { InputUtils } from './game/InputUtils'
import { PlayerStore } from './game/stores/PlayerStore'
import { Toast } from './game/toast/ToastController'
import { IntroController } from './game/intro/IntroController'
import { RadioService } from './game/radio/RadioService'
import { UIController } from './game/UI/UIController'
import { PlayerController } from './game/player/PlayerController'
import { AuthClient } from './game/realtime/AuthClient'
import { TeleportOptions } from './types/teleport'
import { ModelClient } from './game/api/ModelClient'
import { initializeQuests } from './game/quests/engine/initializeQuests'
import { DonationPopover } from './game/UI/DonationPopover'
import { PAYWALL } from './config'

// Initialize input focus tracking
InputUtils.initialize();
PlayerStore.initializePlayer();
const Threebox = threebox.Threebox;

// Set Mapbox access token
mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

// Global variables
let infoPanel: InfoPanel;
let isSmallScreen = window.innerWidth < 768; // Determine once if this is a small screen device
// Determine performance capabilities - used for rendering optimizations


window.isSmallScreen = isSmallScreen;
window.isLowPerformanceDevice = PlayerStore.getIsLowPerformanceDevice();

let map: mapboxgl.Map | null = null

setupScene();

// Function to set up the scene with vehicle and camera
async function setupScene() {
  // Initialize radio service early
  RadioService.getInstance();

  // Initialize auth client
  const authClient = new AuthClient();

  // Initialize player controller
  const player = new PlayerController();

  // Create a teleport wrapper function that adapts the interface expected by UIController
  const teleportWrapper = (teleportOptions: TeleportOptions) => {
    player.teleport(teleportOptions);
  };

  const realtimeController = new RealtimeController();

  // Remove the navigation toggle button since it will be part of the minimap now
  const existingToggle = document.querySelector('.navigation-toggle');
  if (existingToggle) {
    existingToggle.remove();
  }

  // Initialize info panel only if not on a small screen
  if (!isSmallScreen) {
    infoPanel = new InfoPanel();
  }

  // Add keyboard shortcut to toggle info panel (I key)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'i' || e.key === 'I') {
      infoPanel?.toggle();
    }
  });

  // Check if user is already authenticated
  const authResult = await authClient.checkAuthentication();

  if (authResult) {

    // Update player store with user data
    PlayerStore.setPlayerName(authResult.username);
    PlayerStore.setIsGuest(authResult.isGuest);
    PlayerStore.setPlayerId(authResult.playerId);
    //If user hasn't paid, show intro with payment step
    if (PAYWALL && !authResult.hasPaid) {
      const introController = new IntroController(authClient);
      await introController.showIntro(authResult, (initialPosition: [number, number]) => {
        initializeGame(player, initialPosition, realtimeController, teleportWrapper);
      });
      return;
    }

    // If user has paid, proceed with the game
    let hasPosition = false;
    if (authResult.lastPosition) {
      PlayerStore.setCoordinates([authResult.lastPosition.x, authResult.lastPosition.y, authResult.lastPosition.z]);
      hasPosition = true;
    }

    // Initialize the game
    initializeGame(
      player,
      hasPosition ? [PlayerStore.getCoordinates()[0], PlayerStore.getCoordinates()[1]] : [DEFAULT_COORDINATES.lng, DEFAULT_COORDINATES.lat],
      realtimeController,
      teleportWrapper
    );
  } else {
    // User is not authenticated, sign in anonymously and skip email gating
    const guestAuth = await authClient.signInAnonymously();

    PlayerStore.setPlayerName(guestAuth.username);
    PlayerStore.setIsGuest(guestAuth.isGuest);
    PlayerStore.setPlayerId(guestAuth.playerId);

    if (guestAuth.lastPosition) {
      PlayerStore.setCoordinates([guestAuth.lastPosition.x, guestAuth.lastPosition.y, guestAuth.lastPosition.z]);
    }

    const introController = new IntroController(authClient, (name: string) => {
      // Fire and forget name change
      realtimeController.changePlayerName(name);
    });

    await introController.showIntro(guestAuth, (initialPosition: [number, number]) => {
      initializeGame(player, initialPosition, realtimeController, teleportWrapper);
    });
  }
}

/**
 * Initialize the game after authentication is successful
 */
function initializeGame(
  player: PlayerController,
  initialPosition: [number, number],
  realtimeController: RealtimeController,
  teleport: (teleportOptions: TeleportOptions) => void
) {
  // Set up map with performance-optimized options
  const mapOptions: mapboxgl.MapOptions = {
    container: 'map',
    style: PlayerStore.getMap() === 'satellite' ? MAPBOX_STYLE_SATELLITE : MAPBOX_STYLE_STANDARD,
    center: [0, 0], // Start at center of the world (will be changed by intro)
    zoom: 1.5, // Zoomed all the way out to see the entire Earth
    pitch: 0, // Start with a top-down view
    bearing: DEFAULT_COORDINATES.bearing,
    antialias: !window.isLowPerformanceDevice, // Disable antialiasing on low-performance devices
    // Enable only zoom-related interactions
    interactive: true, // Need this for touch interactions
    boxZoom: false,
    dragRotate: false,
    dragPan: false, // Enable for MacOS touchpad support
    keyboard: false,
    doubleClickZoom: false,
    touchZoomRotate: false,
    touchPitch: false,
    scrollZoom: false,
    maxPitch: window.isLowPerformanceDevice ? 85 : 85, // Limit pitch on low-performance devices
    fadeDuration: window.isLowPerformanceDevice ? 0 : 300, // Disable fade animations on low-performance devices
    preserveDrawingBuffer: false // Better performance when false
  };

  map = new mapboxgl.Map(mapOptions);


  map.setConfigProperty('basemap', 'lightPreset', PlayerStore.getTimeOfDay() || 'dusk');
  // Add terrain source and layer
  map.on('style.load', () => {


    if (!window.isLowPerformanceDevice) {
      try {


        map?.addSource('mapbox-dem', {
          'type': 'raster-dem',
          'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
          'tileSize': 512,
          'maxzoom': 18,  // Reduced from 14 to improve performance
          'minzoom': 3    // Add minzoom to prevent loading terrain data when zoomed out
        });

        map?.setTerrain({
          'source': 'mapbox-dem',
          'exaggeration': PlayerStore.getTerrainExaggeration(),
        });

        // Listen for terrain exaggeration changes
        window.addEventListener('terrain:exaggeration_changed', ((event: CustomEvent) => {
          map?.setTerrain({
            'source': 'mapbox-dem',
            'exaggeration': event.detail.value,
          });
        }) as EventListener);
      } catch (error) {
        console.error('Failed to add terrain:', error);
      }
    }

    // Add custom layer for Threebox
    map?.addLayer({
      id: 'custom-threebox-layer',
      type: 'custom',
      renderingMode: '3d',
      onAdd: function (map: mapboxgl.Map, gl: WebGLRenderingContext) {
        // Initialize Threebox
        window.tb = new Threebox(
          map,
          gl,
          {
            defaultLights: true,
            enableSelectingObjects: false,
            enableDraggingObjects: false,
            enableTooltips: false,
            enableSelectingFeatures: false,
          }
        )

        // Initialize camera controller
        CameraController.initialize(map, window.tb);
        CameraController.setCameraSettings({
          pitch: DEFAULT_COORDINATES.pitch,
          distance: 40,
          height: 5,
          zoom: DEFAULT_COORDINATES.zoom || 5
        });

        // Initialize UI controller
        new UIController(
          map!,
          teleport,
          realtimeController.changePlayerName.bind(realtimeController),
          player.setKeyState.bind(player),
          player.switchToCar.bind(player),
          player.switchToWalking.bind(player),
          player.toggleFlyingMode.bind(player),
          player
        );

        // Initialize model client
        const modelClient = new ModelClient();

        // Initialize quests first
        initializeQuests();

        // Connect to websocket
        realtimeController.connect(map, window.tb!).then(async () => {
          // Initialize player state at the provided position
          player.initializeState(window.tb!, map!, initialPosition);

          // Fetch unlocked models from the server
          try {
            const unlockedModels = await modelClient.getUnlockedModels();
            PlayerStore.setUnlockedModels(unlockedModels);
          } catch (error) {
            console.error('Failed to fetch unlocked models:', error);
          }

          // TODO: Uncomment this when we want to show the donation popover
          // setTimeout(() => {
          //   DonationPopover.showFirst(() => {
          //     window.showModelSelector();
          //   });
          // }, 1000);

          setTimeout(() => {
            window.showModelSelector();
          }, 1000);

          Toast.show({
            type: 'success',
            message: 'Welcome to Gothenburg! Enjoy your drive!',
            duration: 3000
          });
        });

        // Set up the scene and start the intro animation
      },
      render: function (_gl: WebGLRenderingContext, _matrix: number[]) {
        // Update Threebox scene on each frame
        window.tb?.update()
      }
    } as any)
  })
}

// Update Window interface
declare global {
  interface Window {
    tb: any;
    isSmallScreen: boolean;
    isLowPerformanceDevice: boolean;
    showModelSelector: () => void;
  }
}

// Make isSmallScreen accessible globally
window.isSmallScreen = isSmallScreen;

// Add event listener to save position before page unloads
window.addEventListener('beforeunload', () => {
  // Clean up radio
  RadioService.getInstance().destroy();
  // Clean up donation popover
  DonationPopover.destroy();
});

