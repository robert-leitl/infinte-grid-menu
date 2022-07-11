export default "#version 300 es\n\nprecision highp float;\n#define GLSLIFY 1\n\nuniform float uFrames;\nuniform float uScaleFactor;\nuniform vec3 uCameraPosition;\n\nout vec4 outColor;\n\nin vec2 vUvs;\nin float vAlpha;\nflat in int vInstanceId;\n\nvoid main() {\n    outColor = vec4(0., 1., float(vInstanceId) / 42., 1.);\n\n    //outColor *= vAlpha;\n}"