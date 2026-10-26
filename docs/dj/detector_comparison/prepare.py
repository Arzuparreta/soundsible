"""Download pinned sources/weights and fixed GTZAN inputs for reproduction.

Run this with the isolated experiment environment, not the engine environment.
Ballroom audio is supplied separately from the original contest archive.
"""
from __future__ import annotations

import argparse
import hashlib
import io
from pathlib import Path, PurePosixPath
import shutil
import urllib.request
import zipfile

from .common import write_json

SOURCES = {
    'CPJKU/beat_this': 'b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c',
    'mjhydri/BeatNet': '81cedd4beeb7235262db80969a0c9ce9a48a0ed4',
    'CPJKU/madmom': '27f032e8947204902c675e5e341a3faf5dc86dae',
    'imcmurray/madmom-modern': 'df718c704a3b460ac6c61b7e61663a0436b91bda',
    'zhaojw1998/Beat-Transformer': '063667fc9e4e11507f9d76dc1154d9db953a85eb',
    'mir-aidj/all-in-one': '18e78903c0365147a2c5d4e5e57ebf88cb7d800e',
    'mjhydri/BeatNet-Plus': 'bb90eb0a9065b101a4b4c4cb2b2061950266cb4b',
}


def download(url, target):
    target = Path(target)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix+'.download')
        with urllib.request.urlopen(url, timeout=120) as source, temporary.open('wb') as output:
            shutil.copyfileobj(source, output)
        temporary.replace(target)
    return target


def archive(repo, revision, target):
    if (target/'.revision').exists():
        assert (target/'.revision').read_text().strip() == revision
        return
    data = urllib.request.urlopen(f'https://codeload.github.com/{repo}/zip/{revision}', timeout=120).read()
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        prefix = package.namelist()[0].split('/')[0]
        for name in package.namelist():
            relative = PurePosixPath(name).relative_to(prefix)
            if not relative.parts or name.endswith('/'):
                continue
            if '..' in relative.parts:
                raise ValueError(name)
            file = target/relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(package.read(name))
    (target/'.revision').write_text(revision+'\n')


def prepare(root):
    root.mkdir(parents=True, exist_ok=True)
    for repo, revision in SOURCES.items():
        archive(repo, revision, root/'sources'/repo.replace('/', '_'))
    models_revision = '7e3dc1b0cad499792767074d03c38b194b9b0a79'
    archive('CPJKU/madmom_models', models_revision, root/'sources/CPJKU_madmom/madmom/models')
    for rev in ['8f520a797c3470c1e2a53d86673ef6694dd3105c', '2ca8ccf248d4fe38caa664ec7442332a59160353']:
        name = '2ca8ccf2' if rev.startswith('2ca8ccf2') else rev
        archive('Arzuparreta/soundsible', rev, root/'snapshots'/name)
    for model in ['small0', 'final0']:
        target = root/'checkpoints'/(model+'.ckpt')
        download(f'https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/{model}.ckpt', target)
    audio_revision = 'a61439e86c13037011fde8e0f0743ec55c50bce3'
    annotation_revision = 'c3c47fd37d3074d9f8119f18bbf460f909609f22'
    cases = []
    for genre in ['blues', 'classical', 'country', 'disco', 'hiphop', 'jazz', 'metal', 'pop', 'reggae', 'rock']:
        for index in range(3):
            stem = f'{genre}.{index:05}'
            audio_url = f'https://raw.githubusercontent.com/TempoBeatDownbeat/gtzan_mini/{audio_revision}/genres/{genre}/{stem}.wav'
            annotation_url = f'https://raw.githubusercontent.com/CPJKU/beat_this_annotations/{annotation_revision}/gtzan/annotations/beats/gtzan_{genre}_{index:05}.beats'
            audio = download(audio_url, root/'corpus'/(stem+'.wav'))
            annotation = download(annotation_url, root/'corpus'/(stem+'.beats'))
            cases.append(dict(id=f'gtzan_{genre}_{index:05}', file=str(audio), annotation=str(annotation),
                              audio_url=audio_url, annotation_url=annotation_url, genre=genre, dataset='GTZAN',
                              split='development' if index == 0 else 'test',
                              file_sha256=hashlib.sha256(audio.read_bytes()).hexdigest(),
                              annotation_sha256=hashlib.sha256(annotation.read_bytes()).hexdigest()))
    write_json(root/'corpus/gtzan-manifest.json', dict(audio_revision=audio_revision,
                                                    annotation_revision=annotation_revision, cases=cases))


def separated_weights(root):
    """Prepare optional heavy frontends before timing, in their own environments.

    All-In-One assets are revision-addressed. Spleeter's upstream provider
    verifies the release checksum; the exported experiment records each file.
    """
    from .common import scratch
    import subprocess
    scratch(root)
    revision = '379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19'
    names = ['harmonix-fold0-0vra4ys2.pth', 'harmonix-fold1-3ozjhtsj.pth',
             'harmonix-fold2-gmgo0nsy.pth', 'harmonix-fold3-i92b7m8p.pth',
             'harmonix-fold4-1bql5qo0.pth', 'harmonix-fold5-x4z5zeef.pth',
             'harmonix-fold6-x7t226rq.pth', 'harmonix-fold7-qwwskhg6.pth']
    for name in names:
        download(f'https://huggingface.co/taejunkim/allinone/resolve/{revision}/{name}', root/'checkpoints'/name)
    write_json(root/'allin1-hf-metadata.json', dict(sha=revision, repo_id='taejunkim/allinone', names=names))
    subprocess.run([str(root/'venv/bin/python'), '-c',
                    "from demucs.pretrained import get_model; get_model('htdemucs')"], check=True)
    subprocess.run([str(root/'spleeter232-venv/bin/python'), '-c',
                    "from spleeter.model.provider import ModelProvider; ModelProvider.default().get('5stems')"],
                   cwd=root, check=True)
    assets = []
    for folder in [root/'checkpoints', root/'pretrained_models/5stems']:
        for file in sorted(folder.iterdir()):
            if file.is_file():
                assets.append(dict(path=str(file.relative_to(root)), bytes=file.stat().st_size,
                                   sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
    write_json(root/'prepared-separated-assets.json', dict(huggingface_revision=revision, assets=assets))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--separated-weights', action='store_true')
    args = parser.parse_args()
    if args.separated_weights:
        separated_weights(args.root)
    else:
        prepare(args.root)
