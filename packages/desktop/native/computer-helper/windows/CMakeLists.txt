cmake_minimum_required(VERSION 3.21)
cmake_policy(SET CMP0091 NEW)
project(VectorComputer LANGUAGES CXX RC)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "Build the Windows helper with MSVC on Windows.")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "The Windows helper supports x64 and ARM64 only.")
endif()
if(NOT CMAKE_VS_PLATFORM_NAME MATCHES "^(x64|ARM64)$")
  message(FATAL_ERROR "Configure with -A x64 or -A ARM64.")
endif()
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(VECTOR_COMPUTER_GENERATED_DIR "" CACHE PATH "C1 generated identity and blocklist headers")
set(VECTOR_COMPUTER_SOURCE_DIGEST "" CACHE STRING "C2 measured source digest")
string(LENGTH "${VECTOR_COMPUTER_SOURCE_DIGEST}" SOURCE_DIGEST_LENGTH)
if(NOT SOURCE_DIGEST_LENGTH EQUAL 64 OR NOT VECTOR_COMPUTER_SOURCE_DIGEST MATCHES "^[0-9a-f]+$")
  message(FATAL_ERROR "C2 must supply the measured 64-character source digest.")
endif()
foreach(HEADER identity.h blocklist.h)
  if(NOT EXISTS "${VECTOR_COMPUTER_GENERATED_DIR}/${HEADER}")
    message(FATAL_ERROR "Run the C1 identity generator before configuring this project.")
  endif()
endforeach()

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../identity.json" IDENTITY_JSON)
string(JSON HELPER_DISPLAY_NAME GET "${IDENTITY_JSON}" displayName)
string(JSON HELPER_VERSION GET "${IDENTITY_JSON}" helperVersion)
string(JSON HELPER_EXECUTABLE GET "${IDENTITY_JSON}" windows executable)
string(JSON HELPER_MAC_BUNDLE GET "${IDENTITY_JSON}" mac bundle)
string(JSON HELPER_MAC_EXECUTABLE GET "${IDENTITY_JSON}" mac executable)
string(JSON HELPER_MAC_MINIMUM_SYSTEM_VERSION GET "${IDENTITY_JSON}" mac minimumSystemVersion)
foreach(VALUE HELPER_MAC_BUNDLE HELPER_MAC_EXECUTABLE HELPER_MAC_MINIMUM_SYSTEM_VERSION)
  string(REPLACE "\\" "\\\\" ${VALUE} "${${VALUE}}")
  string(REPLACE "\"" "\\\"" ${VALUE} "${${VALUE}}")
endforeach()
if(NOT HELPER_VERSION MATCHES "^[0-9]+[.][0-9]+[.][0-9]+$" OR NOT HELPER_EXECUTABLE STREQUAL "vector-computer.exe")
  message(FATAL_ERROR "The generated helper identity is incompatible with this target.")
endif()
string(REPLACE "." "," HELPER_VERSION_NUMERIC "${HELPER_VERSION}")
set(HELPER_VERSION_NUMERIC "${HELPER_VERSION_NUMERIC},0")
set(VECTOR_COMPUTER_MANIFEST "${CMAKE_CURRENT_SOURCE_DIR}/vector-computer.manifest")
set(VECTOR_COMPUTER_IDENTITY_INPUT "${CMAKE_CURRENT_SOURCE_DIR}/../identity.json")
set(VECTOR_COMPUTER_BLOCKLIST_INPUT "${CMAKE_CURRENT_SOURCE_DIR}/../blocklist.json")
configure_file(src/build-config.h.in generated/build-config.h @ONLY)
configure_file(version.rc.in generated/version.rc @ONLY)
configure_file(tests/inputs.rc.in generated/test-inputs.rc @ONLY)

add_library(computer-core STATIC src/core.cpp src/protocol.cpp src/server.cpp src/parent_identity.cpp src/lifecycle.cpp src/availability.cpp
  src/windows_identity.cpp src/windows_enum.cpp src/windows_apps.cpp src/windows_com.cpp src/windows_icon.cpp
  src/windows_policy.cpp src/windows_process_tree.cpp src/program_registry.cpp src/windows_program.cpp src/guard.cpp
  src/capture.cpp src/capture_native.cpp src/capture_math.cpp
  src/input.cpp src/input_native.cpp src/input_events.cpp src/input_held.cpp src/input_keys.cpp src/input_guardian.cpp
  src/uia_native.cpp src/uia_input.cpp src/accessibility.cpp src/accessibility_registry.cpp
  src/user_input.cpp src/user_input_native.cpp)
target_include_directories(computer-core PUBLIC src "${VECTOR_COMPUTER_GENERATED_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_compile_definitions(computer-core PUBLIC UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00 WINVER=0x0A00)
target_link_libraries(computer-core PUBLIC windowsapp uiautomationcore d3d11 dxgi gdi32 user32 shcore wintrust crypt32 advapi32 shell32 ole32 bcrypt xmllite version dwmapi propsys uuid shlwapi windowscodecs imm32 normaliz)

add_executable(vector-computer WIN32 src/main.cpp "${CMAKE_CURRENT_BINARY_DIR}/generated/version.rc")
target_link_libraries(vector-computer PRIVATE computer-core)
# The explicit resource is the whole application manifest; suppress the linker's separate default manifest.
target_link_options(vector-computer PRIVATE /MANIFEST:NO)
set_target_properties(vector-computer PROPERTIES OUTPUT_NAME vector-computer WIN32_EXECUTABLE ON)

add_executable(vector-computer-tests tests/main.cpp tests/protocol_tests.cpp tests/server_tests.cpp tests/parent_identity_tests.cpp tests/lifecycle_tests.cpp tests/integration_tests.cpp
  tests/windows_identity_tests.cpp tests/windows_enum_tests.cpp tests/windows_icon_tests.cpp tests/windows_policy_tests.cpp tests/windows_process_tree_tests.cpp
  tests/program_registry_tests.cpp tests/windows_program_tests.cpp tests/guard_tests.cpp tests/capture_math_tests.cpp tests/capture_tests.cpp
  tests/input_tests.cpp tests/input_held_tests.cpp tests/input_keys_tests.cpp tests/input_guardian_tests.cpp tests/uia_native_tests.cpp tests/uia_input_tests.cpp
  tests/accessibility_tests.cpp tests/accessibility_registry_tests.cpp tests/availability_tests.cpp tests/user_input_tests.cpp "${CMAKE_CURRENT_BINARY_DIR}/generated/test-inputs.rc")
target_link_libraries(vector-computer-tests PRIVATE computer-core xmllite version)
add_dependencies(vector-computer-tests vector-computer)

# A separate console fixture is copied under the generated channel executable name by the test driver.
# It is never installed in the shipping helper directory.
add_executable(computer-test-caller tests/caller.cpp)
target_link_libraries(computer-test-caller PRIVATE computer-core)
set_target_properties(computer-test-caller PROPERTIES OUTPUT_NAME VectorComputerCaller)
add_dependencies(vector-computer-tests computer-test-caller)

# W11 supplies the isolated window and native interaction cases. This target currently exits with an honest skip.
add_executable(computer-test-target WIN32 tests/target.cpp)
target_compile_definitions(computer-test-target PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)

foreach(TARGET computer-core vector-computer vector-computer-tests computer-test-target computer-test-caller)
  target_compile_options(${TARGET} PRIVATE
    "$<$<COMPILE_LANGUAGE:CXX>:/W4;/WX;/EHsc;/utf-8;/guard:cf;/sdl;/Brepro;/Zc:__cplusplus>")
  if(NOT "${TARGET}" STREQUAL "computer-core")
    target_link_options(${TARGET} PRIVATE /guard:cf /Brepro "/PDBALTPATH:%_PDB%")
    if(CMAKE_VS_PLATFORM_NAME STREQUAL "x64")
      target_link_options(${TARGET} PRIVATE /CETCOMPAT)
    endif()
  endif()
endforeach()

enable_testing()
add_test(NAME computer-helper-unit COMMAND vector-computer-tests)
