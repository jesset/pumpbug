# SPDX-FileCopyrightText: 2026 ludable
# SPDX-License-Identifier: AGPL-3.0-only

find_program(NODE_EXECUTABLE node REQUIRED)
find_package(Python3 COMPONENTS Interpreter REQUIRED)

function(add_host_test name)
  add_executable(${name} ${name}.cpp ${ARGN})
  target_compile_features(${name} PRIVATE cxx_std_17)
  target_compile_options(${name} PRIVATE -Wall -Wextra)
  target_include_directories(${name} PRIVATE "${PROJECT_SOURCE_DIR}/src")
  add_test(NAME ${name} COMMAND ${name})
endfunction()

add_host_test(test_navigation_stack)
add_host_test(
  test_json_validate
  "${PROJECT_SOURCE_DIR}/src/util/json_validate.cpp"
)
add_host_test(
  test_shot_counter
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/ShotCounter.cpp"
)
target_include_directories(
  test_shot_counter BEFORE PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)
add_host_test(
  test_shot_id_reservation
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/shot_id_reservation.cpp"
)
target_include_directories(
  test_shot_id_reservation BEFORE PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)
add_host_test(
  test_shot_store
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/ShotStore.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/shot_metadata_codec.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/shot_id_reservation.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/ExtractionWire.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/extraction_encoding.cpp"
  "${PROJECT_SOURCE_DIR}/src/util/crc32.cpp"
  "${PROJECT_SOURCE_DIR}/src/util/json_validate.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/stubs/storage_file_access.cpp"
)
target_include_directories(
  test_shot_store
  BEFORE PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)
add_host_test(
  test_shot_history_routes
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/ShotHistoryRoutes.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/ShotStore.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/shot_metadata_codec.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/shot_id_reservation.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/ExtractionWire.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/extraction_encoding.cpp"
  "${PROJECT_SOURCE_DIR}/src/util/crc32.cpp"
  "${PROJECT_SOURCE_DIR}/src/util/json_validate.cpp"
  "${PROJECT_SOURCE_DIR}/src/net/ChunkedResponse.cpp"
  "${PROJECT_SOURCE_DIR}/src/net/JsonStream.cpp"
  "${PROJECT_SOURCE_DIR}/src/net/http_request_validation.cpp"
  "${PROJECT_SOURCE_DIR}/src/net/http_response_util.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/stubs/storage_file_access.cpp"
)
target_include_directories(
  test_shot_history_routes BEFORE PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)
add_host_test(
  test_shot_metadata_codec
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/shot_metadata_codec.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/extraction_encoding.cpp"
  "${PROJECT_SOURCE_DIR}/src/util/crc32.cpp"
)
add_host_test(test_storage "${PROJECT_SOURCE_DIR}/src/util/storage.cpp")
target_include_directories(
  test_storage BEFORE PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)
add_host_test(test_battery_level)
add_host_test(
  test_low_battery_shutdown_policy
  "${PROJECT_SOURCE_DIR}/src/power/LowBatteryShutdownPolicy.cpp"
)
add_host_test(test_ble_startup_retry_policy)
add_host_test(test_pair_redirect_policy)
add_host_test(test_bluetooth_controller_transition)
add_host_test(test_wifi_power_save)
add_host_test(test_scale_radio_policy)
add_host_test(
  test_scale_radio_state_machine
  "${PROJECT_SOURCE_DIR}/src/power/ScaleRadioStateMachine.cpp"
)
add_host_test(
  test_scale_radio_convergence
  "${PROJECT_SOURCE_DIR}/src/power/ScaleRadioStateMachine.cpp"
)
add_host_test(
  test_scale_reading_timing_observer
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/ScaleReadingTimingObserver.cpp"
)
target_compile_definitions(
  test_scale_reading_timing_observer
  PRIVATE PB_SCALE_READING_TIMING=1
)

add_host_test(
  test_speaker_codec
  "${PROJECT_SOURCE_DIR}/src/power/SpeakerCodec.cpp"
)
target_include_directories(
  test_speaker_codec BEFORE PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)

add_host_test(
  test_power_saving_policy
  "${PROJECT_SOURCE_DIR}/src/power/PowerSavingPolicy.cpp"
)
# Keep src before stubs to use the actual policy and event-log declarations.
target_include_directories(
  test_power_saving_policy PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)

add_host_test(
  test_power_manager
  "${PROJECT_SOURCE_DIR}/src/power/LowBatteryShutdownPolicy.cpp"
  "${PROJECT_SOURCE_DIR}/src/power/PowerManager.cpp"
  "${PROJECT_SOURCE_DIR}/src/power/ScaleRadioStateMachine.cpp"
  "${PROJECT_SOURCE_DIR}/src/power/SpeakerCodec.cpp"
)
target_include_directories(
  test_power_manager BEFORE PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
)

add_host_test(
  test_acaia_codec
  "${PROJECT_SOURCE_DIR}/src/ble/AcaiaV2Codec.cpp"
)
target_include_directories(
  test_acaia_codec PRIVATE "${PROJECT_SOURCE_DIR}/src/ble"
)

foreach(name
    test_flow_estimator
    test_live_pour_tracker
    test_pour_evidence
    test_extraction_diagnosis
    test_shot_replayer)
  add_host_test(${name})
  target_include_directories(
    ${name} PRIVATE "${PROJECT_SOURCE_DIR}/src/apps/extraction"
  )
endforeach()

add_executable(test_robust_flow test_robust_flow.cpp)
target_compile_features(test_robust_flow PRIVATE cxx_std_17)
target_compile_options(test_robust_flow PRIVATE -Wall -Wextra)
target_include_directories(
  test_robust_flow
  PRIVATE
  "${PROJECT_SOURCE_DIR}/src"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction"
)
add_test(
  NAME test_robust_flow
  COMMAND test_robust_flow "${CMAKE_CURRENT_SOURCE_DIR}/robust_flow_reference.tsv"
)

add_test(
  NAME test_robust_flow_js
  COMMAND
    "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_robust_flow_js.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/robust_flow_reference.tsv"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/robust-flow.js"
)

add_test(
  NAME test_flow_profile_js
  COMMAND
    "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_flow_profile_js.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/robust-flow.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/flow-profile.js"
)

add_test(
  NAME test_extraction_protocol_js
  COMMAND
    "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_extraction_protocol_js.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/protocol.js"
)

add_test(
  NAME test_extraction_constants_js
  COMMAND
    "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_extraction_constants_js.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/constants.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/stream.js"
    "${PROJECT_SOURCE_DIR}/src/apps/extraction/ExtractionStream.h"
    "${PROJECT_SOURCE_DIR}/src/apps/extraction/Extraction.h"
)

add_test(
  NAME test_shot_metadata_ui_js
  COMMAND
    "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_shot_metadata_ui.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-metadata.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-history.js"
    "${PROJECT_SOURCE_DIR}/src/apps/extraction/history/shot_metadata_codec.h"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/constants.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-icons.js"
)

add_test(
  NAME test_history_coordinator_js
  COMMAND
    "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_history_coordinator.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-metadata.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-history.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/constants.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/stream.js"
    "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-icons.js"
)

add_test(
  NAME test_package_m5burner
  COMMAND
    "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_package_m5burner.py"
)

add_test(
  NAME test_build_web
  COMMAND
    "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test_build_web.py"
)

add_test(
  NAME test_license_headers
  COMMAND
    "${Python3_EXECUTABLE}"
    "${PROJECT_SOURCE_DIR}/scripts/check_license_headers.py"
)

add_host_test(
  test_target_alert
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/TargetAlert.cpp"
)
target_include_directories(
  test_target_alert PRIVATE "${PROJECT_SOURCE_DIR}/src/apps/extraction"
)

add_host_test(test_vibration_window_trigger)
add_host_test(test_pump_decay_tracker)
add_host_test(test_pump_cluster_selector)
add_host_test(
  test_backflush_cycle
  "${PROJECT_SOURCE_DIR}/src/apps/backflush/BackflushCycle.cpp"
)

add_host_test(
  test_extraction_recorder
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/ExtractionRecorder.cpp"
)
target_include_directories(
  test_extraction_recorder
  BEFORE PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction"
)

add_host_test(
  test_extraction_wire
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/ExtractionWire.cpp"
  "${PROJECT_SOURCE_DIR}/src/apps/extraction/extraction_encoding.cpp"
)
target_include_directories(
  test_extraction_wire PRIVATE "${PROJECT_SOURCE_DIR}/src/apps/extraction"
)

add_host_test(test_target_store "${PROJECT_SOURCE_DIR}/src/apps/extraction/TargetStore.cpp")
target_include_directories(test_target_store BEFORE PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/stubs")

add_test(NAME test_recipe_target_js COMMAND "${NODE_EXECUTABLE}"
  "${CMAKE_CURRENT_SOURCE_DIR}/test_recipe_target.js"
  "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-metadata.js"
  "${PROJECT_SOURCE_DIR}/web-src/app/extraction/constants.js"
  "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-live.js")

add_test(NAME test_extraction_header_js COMMAND "${NODE_EXECUTABLE}"
  "${CMAKE_CURRENT_SOURCE_DIR}/test_extraction_header.js"
  "${PROJECT_SOURCE_DIR}/web-src/app/extraction/ui-live.js"
  "${PROJECT_SOURCE_DIR}/web-src/app/extraction/app.js"
  "${PROJECT_SOURCE_DIR}/web-src/app/extraction/constants.js"
  "${PROJECT_SOURCE_DIR}/web-src/app/extraction/stream.js")

add_host_test(
  test_lm_crypto
  "${PROJECT_SOURCE_DIR}/src/ble/lamarzocco/LmCrypto.cpp"
)
add_host_test(
  test_lm_notification
  "${PROJECT_SOURCE_DIR}/src/ble/lamarzocco/LmNotification.cpp"
  "${PROJECT_SOURCE_DIR}/src/ble/lamarzocco/LmJson.cpp"
)
add_host_test(
  test_lm_cloud_models
  "${PROJECT_SOURCE_DIR}/src/ble/lamarzocco/LmCloudModels.cpp"
  "${PROJECT_SOURCE_DIR}/src/ble/lamarzocco/LmJson.cpp"
)

add_host_test(
  test_brew_signal_mux
  "${PROJECT_SOURCE_DIR}/src/ble/lamarzocco/BrewSignalMux.cpp"
)

add_host_test(
  test_lm_gatt
)
