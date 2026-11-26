cmake_minimum_required(VERSION 3.27)
cmake_policy(SET CMP0091 NEW)
project(VectorHolderProbe LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR
   NOT CMAKE_VS_PLATFORM_NAME MATCHES "^(x64|ARM64)$")
  message(FATAL_ERROR "The Windows holder probe requires x64 or ARM64 MSVC.")
endif()

add_executable(vector-holder-probe holder.cpp)
set_target_properties(vector-holder-probe PROPERTIES
  OUTPUT_NAME holder
  MSVC_RUNTIME_LIBRARY MultiThreaded
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED YES
  CXX_EXTENSIONS NO
)
target_link_options(vector-holder-probe PRIVATE /DYNAMICBASE /NXCOMPAT)
