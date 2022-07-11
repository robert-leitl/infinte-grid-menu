import { mat3, mat4, quat, vec2, vec3 } from "gl-matrix";
import { DiscGeometry } from "./geometry/disc-geometry";
import { IcosahedronGeometry } from "./geometry/icosahedron-geometry";
import { ArcballControl } from './arcball-control';
import { createAndSetupTexture, createFramebuffer, createProgram, makeBuffer, makeVertexArray, resizeCanvasToDisplaySize, setFramebuffer } from './utils/webgl-utils';

import discVertShaderSource from './shader/disc.vert.glsl';
import discFragShaderSource from './shader/disc.frag.glsl';

export class InfiniteGridMenu {

    TARGET_FRAME_DURATION = 1000 / 60;  // 60 fps

    SPHERE_RADIUS = 2;

    #time = 0;
    #deltaTime = 0;

    // relative frames according to the target frame duration (1 = 60 fps)
    // gets smaller with higher framerates --> use to adapt animation timing
    #deltaFrames = 0;

    // total frames since the start
    #frames = 0;

    camera = {
        matrix: mat4.create(),
        near: 0.5,
        far: 10,
        fov: Math.PI / 4,
        aspect: 1,
        position: vec3.fromValues(0, 0, 7),
        up: vec3.fromValues(0, 1, 0),
        matrices: {
            view: mat4.create(),
            projection: mat4.create(),
            inversProjection: mat4.create()
        }
    };

    constructor(canvas, onInit = null) {
        this.canvas = canvas;

        this.#init(onInit);
    }

    resize() {
        this.viewportSize = vec2.set(
            this.viewportSize,
            this.canvas.clientWidth,
            this.canvas.clientHeight
        );

        const gl = this.gl;

        const needsResize = resizeCanvasToDisplaySize(gl.canvas);
        
        if (needsResize) {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }

        this.#updateProjectionMatrix(gl);
    }

    run(time = 0) {
        this.#deltaTime = Math.min(32, time - this.#time);
        this.#time = time;
        this.#deltaFrames = this.#deltaTime / this.TARGET_FRAME_DURATION;
        this.#frames += this.#deltaFrames

        this.#animate(this.#deltaTime);
        this.#render();

        requestAnimationFrame((t) => this.run(t));
    }

    #init(onInit) {
        this.gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false });

        /** @type {WebGLRenderingContext} */
        const gl = this.gl;

        if (!gl) {
            throw new Error('No WebGL 2 context!')
        }

        // init client dimensions
        this.viewportSize = vec2.fromValues(
            this.canvas.clientWidth,
            this.canvas.clientHeight
        );
        this.drawBufferSize = vec2.clone(this.viewportSize);

        // setup programs
        this.discProgram = createProgram(gl, [discVertShaderSource, discFragShaderSource], null, { aModelPosition: 0, aModelNormal: 1, aModelUvs: 2, aInstanceMatrix: 3 });

        // find the locations
        this.discLocations = {
            aModelPosition: gl.getAttribLocation(this.discProgram, 'aModelPosition'),
            aModelUvs: gl.getAttribLocation(this.discProgram, 'aModelUvs'),
            aInstanceMatrix: gl.getAttribLocation(this.discProgram, 'aInstanceMatrix'),
            uWorldMatrix: gl.getUniformLocation(this.discProgram, 'uWorldMatrix'),
            uViewMatrix: gl.getUniformLocation(this.discProgram, 'uViewMatrix'),
            uProjectionMatrix: gl.getUniformLocation(this.discProgram, 'uProjectionMatrix'),
            uCameraPosition: gl.getUniformLocation(this.discProgram, 'uCameraPosition'),
            uScaleFactor: gl.getUniformLocation(this.discProgram, 'uScaleFactor'),
            uRotationAxisVelocity: gl.getUniformLocation(this.discProgram, 'uRotationAxisVelocity')
        };

        /////////////////////////////////// GEOMETRY / MESH SETUP

        // create disc VAO
        this.discGeo = new DiscGeometry(36, 1);
        this.discBuffers = this.discGeo.data;
        this.discVAO = makeVertexArray(gl, [
            [makeBuffer(gl, this.discBuffers.vertices, gl.STATIC_DRAW), this.discLocations.aModelPosition, 3],
            [makeBuffer(gl, this.discBuffers.uvs, gl.STATIC_DRAW), this.discLocations.aModelUvs, 2]
        ], (this.discBuffers.indices));

        this.icoGeo = new IcosahedronGeometry();
        this.icoGeo.subdivide(1).spherize(this.SPHERE_RADIUS);
        this.instancePositions = this.icoGeo.vertices.map(v => v.position);
        this.DISC_INSTANCE_COUNT = this.icoGeo.vertices.length;
        this.#initDiscInstances(this.DISC_INSTANCE_COUNT);

        this.worldMatrix = mat4.create();
    
        // init the pointer rotate control
        this.control = new ArcballControl(this.canvas, () => this.#onControlUpdate());
        
        this.#updateCameraMatrix();
        this.#updateProjectionMatrix(gl);

        this.resize();

        if (onInit) onInit(this);
    }

    #initDiscInstances(count) {
        /** @type {WebGLRenderingContext} */
        const gl = this.gl;

        this.discInstances = {
            matricesArray: new Float32Array(count * 16),
            matrices: [],
            buffer: gl.createBuffer()
        }
        for(let i = 0; i < count; ++i) {
            const instanceMatrixArray = new Float32Array(this.discInstances.matricesArray.buffer, i * 16 * 4, 16);
            instanceMatrixArray.set(mat4.create());
            this.discInstances.matrices.push(instanceMatrixArray);
        }

        gl.bindVertexArray(this.discVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.discInstances.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.discInstances.matricesArray.byteLength, gl.DYNAMIC_DRAW);
        const mat4AttribSlotCount = 4;
        const bytesPerMatrix = 16 * 4;
        for(let j = 0; j < mat4AttribSlotCount; ++j) {
            const loc = this.discLocations.aInstanceMatrix + j;
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(
                loc,
                4,
                gl.FLOAT,
                false,
                bytesPerMatrix, // stride, num bytes to advance to get to next set of values
                j * 4 * 4 // one row = 4 values each 4 bytes
            );
            gl.vertexAttribDivisor(loc, 1); // it sets this attribute to only advance to the next value once per instance
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindVertexArray(null);
    }

    #animate(deltaTime) {
        /** @type {WebGLRenderingContext} */
        const gl = this.gl;

        this.control.update(deltaTime);

        // update the instance matrices from the current orientation
        let positions = this.instancePositions.map(p => vec3.transformQuat(vec3.create(), p, this.control.orientation));
        positions.forEach((p, ndx) => {
            const scale = (Math.abs(p[2]) * 0.6 + 0.4) * 0.15;
            const matrix = mat4.create();
            mat4.translate(matrix, matrix, vec3.negate(vec3.create(), p));
            mat4.scale(matrix, matrix, [scale, scale, scale]);
            mat4.multiply(matrix, matrix, mat4.targetTo(mat4.create(), [0, 0, 0], p, [0, 1, 0]));

            mat4.copy(this.discInstances.matrices[ndx], matrix);
        });

        // upload the instance matrix buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.discInstances.buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.discInstances.matricesArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    #render() {
         /** @type {WebGLRenderingContext} */
         const gl = this.gl;

        gl.useProgram(this.discProgram);

        gl.enable(gl.CULL_FACE);
        gl.enable(gl.DEPTH_TEST);

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.uniformMatrix4fv(this.discLocations.uWorldMatrix, false, this.worldMatrix);
        gl.uniformMatrix4fv(this.discLocations.uViewMatrix, false, this.camera.matrices.view);
        gl.uniformMatrix4fv(this.discLocations.uProjectionMatrix, false, this.camera.matrices.projection);
        gl.uniform3f(this.discLocations.uCameraPosition, this.camera.position[0], this.camera.position[1], this.camera.position[2]);
        gl.uniform4f(this.discLocations.uRotationAxisVelocity, this.control.rotationAxis[0], this.control.rotationAxis[1], this.control.rotationAxis[2], this.control.rotationVelocity);
        gl.uniform1f(this.discLocations.uFrames, this.#frames);
        gl.uniform1f(this.discLocations.uScaleFactor, this.scaleFactor);

        gl.bindVertexArray(this.discVAO);

        gl.drawElementsInstanced(
            gl.TRIANGLES,
            this.discBuffers.indices.length,
            gl.UNSIGNED_SHORT,
            0,
            this.DISC_INSTANCE_COUNT
        );
    }

    #updateCameraMatrix() {
        mat4.targetTo(this.camera.matrix, this.camera.position, [0, 0, 0], this.camera.up);
        mat4.invert(this.camera.matrices.view, this.camera.matrix);
    }

    #updateProjectionMatrix(gl) {
        this.camera.aspect = gl.canvas.clientWidth / gl.canvas.clientHeight;
        mat4.perspective(this.camera.matrices.projection, this.camera.fov, this.camera.aspect, this.camera.near, this.camera.far);
        mat4.invert(this.camera.matrices.inversProjection, this.camera.matrices.projection);

        const size = this.SPHERE_RADIUS * 2;
        if (this.camera.aspect > 1) {
            this.cameraWideAngleDistance = (size / 2) / Math.tan(this.camera.fov / 2);
        } else {
            this.cameraWideAngleDistance = (size / 2) / Math.tan ((this.camera.fov * this.camera.aspect) / 2);
        }
        this.cameraWideAngleDistance -= 0.5;
    }

    #onControlUpdate() {
        let damping = 6;
        let cameraTargetZ = this.cameraWideAngleDistance * 0.6;

        if (!this.control.isPointerDown) {
            cameraTargetZ *= 0.9;
            this.control.snapTargetDirection = this.#findNearestSnapDirection();
        } else {
            cameraTargetZ = this.control.rotationVelocity * 12 + this.cameraWideAngleDistance * 0.7;
            damping = 5;
        }

        this.camera.position[2] += (cameraTargetZ - this.camera.position[2]) / damping;
        this.#updateCameraMatrix();
    }

    #findNearestSnapDirection() {
        // map the XY-Plane normal to the model space
        const n = this.control.snapDirection;
        const inversOrientation = quat.conjugate(quat.create(), this.control.orientation);
        // transform the normal to model space
        const nt = vec3.transformQuat(vec3.create(), n, inversOrientation);
        
        // find the nearest vertex 
        const vertices = this.instancePositions;
        let maxD = -1;
        let nearestVertexPos;
        for(let i=0; i<vertices.length; ++i) {
            const d = vec3.dot(nt, vertices[i]);
            if (d > maxD) {
                maxD = d;
                nearestVertexPos = vertices[i];
            }
        }

        const snapDirection = vec3.transformQuat(vec3.create(), nearestVertexPos, this.control.orientation);
        return vec3.normalize(snapDirection, snapDirection);
    }
}