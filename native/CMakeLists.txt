cmake_minimum_required(VERSION 3.10)
project(FroostRook LANGUAGES CXX)

# Portable generic x86-64 build — the same flags as native/build.bat and CI.
#   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
#   cmake --build native/build
# The output lands at native/build/FroostRook.exe (or native/build/FroostRook).
# Do NOT use -march=native here; the portable build is the release artifact.

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

if(MSVC)
  add_compile_options(/O2)
else()
  add_compile_options(-O3 -march=x86-64 -mtune=generic -static)
  add_link_options(-static)
endif()

# Windows resources (icon + version info) must be compiled with windres,
# exactly like build.bat does. Non-Windows builds skip it.
if(WIN32 AND MINGW)
  find_program(WINDRES windres REQUIRED)
  add_custom_command(
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/app.o
    COMMAND ${WINDRES} ${CMAKE_CURRENT_SOURCE_DIR}/app.rc -O coff -o ${CMAKE_CURRENT_BINARY_DIR}/app.o
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/app.rc
    COMMENT "windres app.rc")
  set(APP_RESOURCE ${CMAKE_CURRENT_BINARY_DIR}/app.o)
else()
  set(APP_RESOURCE "")
endif()

add_executable(FroostRook kiwa.cpp nnue.cpp ${APP_RESOURCE})

add_executable(nnue_bench nnue_bench.cpp nnue.cpp)
target_link_libraries(nnue_bench PRIVATE)
