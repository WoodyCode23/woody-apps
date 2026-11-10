'use strict';
/* The inputs Input Lab listens to. Keep in step with app.json "signals" (the permissions). */
module.exports = {
  "de.bmw.infotainment.controlelements.SteeringWheelPushButton": {
    "fields": [
      "operationSteerWheelFAV",
      "operationSteerWheelFC",
      "statusAudioVolumeButton",
      "statusPTTButton1",
      "statusRotaryPress",
      "statusRotarySteps",
      "statusSearchSwitch1",
      "statusSpecialFunctionButton",
      "statusSpecialFunctionButton2",
      "statusSteerWheelFCLED",
      "statusTelephoneButton"
    ],
    "broadcasts": []
  },
  "de.bmw.body.Light": {
    "fields": [
      "IndicatorSteeringColumn",
      "IndicatorSteeringColumnComplete"
    ],
    "broadcasts": []
  },
  "de.bmw.infotainment.controlelements.FrontCCU": {
    "fields": [
      "statusPushButtonsState",
      "statusRotaryEncoderState"
    ],
    "broadcasts": []
  },
  "de.bmw.infotainment.controlelements.CenterStack": {
    "fields": [
      "statusAudioVolumeButtonCS",
      "statusFunctionalBookmarkButtons",
      "statusPushButtonAmFmTP",
      "statusPushButtonAudio",
      "statusPushButtonEject",
      "statusPushButtonMode",
      "statusPushButtonSkip"
    ],
    "broadcasts": []
  },
  "de.bmw.infotainment.controlelements.MyCarButton": {
    "fields": [
      "operationModeButtons",
      "operationMyCarButton"
    ],
    "broadcasts": [
      "displayDassComfortSettingsMenu"
    ]
  },
  "de.bmw.infotainment.controllerelements.gesture.GestureRecognition": {
    "fields": [
      "activations",
      "cameraStatus"
    ],
    "broadcasts": [
      "gestures"
    ]
  }
};
