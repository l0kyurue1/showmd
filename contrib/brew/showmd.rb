require "language/node"

class Showmd < Formula
  desc "Read and edit markdown in your browser"
  homepage "https://github.com/l0kyurue1/showmd"
  url "https://registry.npmjs.org/showmd-cli/-/showmd-cli-0.2.2.tgz"
  sha256 "7bda06fffa19b22e5c140389fbd5b01565c8255e0f17fbc304d937dbe817e370"
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
