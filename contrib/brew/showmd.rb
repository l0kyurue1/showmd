require "language/node"

class Showmd < Formula
  desc "Read and edit markdown in your browser"
  homepage "https://github.com/l0kyurue1/showmd"
  url "https://registry.npmjs.org/showmd-cli/-/showmd-cli-0.2.0.tgz"
  sha256 "8fdb3df2aeb6792fa3d920398980e78812a1e37f61b2710fcb0b48ed04097aed"
  license "MIT"

  depends_on "node"

  livecheck do
    url "https://registry.npmjs.org/showmd-cli/latest"
    strategy :json do |json|
      json["version"]
    end
  end

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/showmd --version")
  end
end
